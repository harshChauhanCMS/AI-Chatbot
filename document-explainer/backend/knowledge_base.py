"""
Local knowledge base for the AI Document Explainer.

Every uploaded document is stored in a SQLite database on disk:
- the document itself (name, type, extracted text),
- searchable chunks with embeddings from a local Ollama model,
- each spreadsheet sheet as a real SQL table for exact calculations.

Nothing leaves this machine, and the data survives restarts.
"""

import hashlib
import json
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
import pymupdf
import requests


# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

DATA_DIR = Path(__file__).with_name("data")
DB_PATH = DATA_DIR / "knowledge.db"

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
EMBED_MODEL = os.getenv("EMBED_MODEL", "nomic-embed-text")

SUPPORTED_EXTENSIONS = {".pdf", ".xlsx", ".xls", ".csv"}

MAX_TEXT_LENGTH = 500_000
MAX_INDEXED_ROWS_PER_SHEET = 20_000
PREVIEW_ROWS = 200

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 150
EMBED_BATCH_SIZE = 64

# Minimum combined relevance score for a chunk to count as a match.
MIN_RELEVANCE = float(os.getenv("MIN_RELEVANCE", "0.6"))
KEYWORD_WEIGHT = 0.15

SQL_TIMEOUT_SECONDS = 5
SQL_MAX_ROWS = 500

_write_lock = threading.Lock()
_index_lock = threading.Lock()
_index_cache: Optional[dict] = None


# --------------------------------------------------
# DATABASE
# --------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    file_type TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    uploaded_at TEXT NOT NULL,
    character_count INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    full_text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    location TEXT NOT NULL,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE TABLE IF NOT EXISTS sheets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    sheet_name TEXT NOT NULL,
    table_name TEXT NOT NULL UNIQUE,
    columns TEXT NOT NULL,
    row_count INTEGER NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)

    with connect() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)


# --------------------------------------------------
# GENERAL HELPERS
# --------------------------------------------------

def get_extension(filename: str) -> str:
    """Return a lowercase file extension."""

    return "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


def clean_value(value: Any) -> Any:
    """Convert pandas and other special values to JSON-safe values."""

    if value is None:
        return ""

    try:
        if pd.isna(value):
            return ""
    except (TypeError, ValueError):
        pass

    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except (TypeError, ValueError):
            pass

    if hasattr(value, "item"):
        try:
            return value.item()
        except (ValueError, TypeError):
            pass

    return value


STOP_WORDS = {
    "the", "a", "an", "is", "are", "was", "were", "be", "been",
    "to", "of", "in", "on", "at", "for", "from", "with", "and",
    "or", "but", "this", "that", "these", "those", "it", "its",
    "me", "my", "you", "your", "we", "our", "i", "what", "which",
    "who", "when", "where", "why", "how", "can", "could", "would",
    "should", "please", "tell", "give", "show", "find", "explain",
    "describe", "summarize", "summary", "document", "documents", "data",
    "details", "about", "all", "list", "print", "according", "based",
    "important", "key", "main", "most", "point", "points", "overview",
    "example", "simple", "simply", "language", "file", "files",
    "contents", "content", "do", "does", "did", "has", "have", "there",
    "many", "much", "want", "need", "name", "names",
}


def get_query_terms(question: str) -> list[str]:
    """Get useful search terms from a question."""

    words = re.findall(r"\b[\w.-]+\b", question.lower())

    return [
        word for word in words
        if word not in STOP_WORDS and len(word) >= 2
    ]


# --------------------------------------------------
# DOCUMENT PARSING
# --------------------------------------------------

def split_text(text: str) -> list[str]:
    """Split text into overlapping chunks, preferring line or sentence ends."""

    text = re.sub(r"[ \t]+", " ", text).strip()

    if len(text) <= CHUNK_SIZE:
        return [text] if text else []

    chunks = []
    start = 0

    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))

        if end < len(text):
            cut = max(
                text.rfind("\n", start + CHUNK_SIZE // 2, end),
                text.rfind(". ", start + CHUNK_SIZE // 2, end),
            )
            if cut != -1:
                end = cut + 1

        chunks.append(text[start:end].strip())

        if end >= len(text):
            break

        start = max(end - CHUNK_OVERLAP, start + 1)

    return [chunk for chunk in chunks if chunk]


def parse_pdf(content: bytes) -> list[tuple[int, str]]:
    """Return (page number, text) for every PDF page that has text."""

    pages = []

    with pymupdf.open(stream=content, filetype="pdf") as pdf_document:
        for page_number, page in enumerate(pdf_document, start=1):
            page_text = page.get_text("text").strip()

            if page_text:
                pages.append((page_number, page_text))

    return pages


def find_header_row(raw: pd.DataFrame) -> int:
    """
    Find the header row of a sheet. Titles or notes above the table
    usually fill only one or two cells, so pick the first row that is
    nearly as full as the fullest of the first rows.
    """

    counts = raw.head(20).notna().sum(axis=1).tolist()

    if not counts or max(counts) == 0:
        return 0

    threshold = 0.6 * max(counts)

    return next(
        index for index, count in enumerate(counts)
        if count >= threshold
    )


def to_numeric_if_possible(series: pd.Series) -> pd.Series:
    """Convert text columns such as '1,200' or '$45' to numbers."""

    if series.dtype != object:
        return series

    non_empty = series.dropna().astype(str).str.strip()
    non_empty = non_empty[non_empty != ""]

    if non_empty.empty:
        return series

    converted = pd.to_numeric(
        non_empty.str.replace(r"[,\s$€£₹%]", "", regex=True),
        errors="coerce",
    )

    if converted.notna().all():
        result = pd.Series(np.nan, index=series.index, dtype=float)
        result[converted.index] = converted
        return result

    return series


def prepare_dataframe(raw: pd.DataFrame) -> pd.DataFrame:
    """Turn a raw sheet (read without a header) into a clean table."""

    raw = raw.dropna(how="all").dropna(axis=1, how="all")

    if raw.empty:
        return raw

    header_position = find_header_row(raw)
    header = raw.iloc[header_position].tolist()
    dataframe = raw.iloc[header_position + 1:].copy()

    columns = []
    seen = set()

    for index, value in enumerate(header, start=1):
        name = str(clean_value(value)).strip() or f"Column {index}"
        unique_name = name
        suffix = 2

        while unique_name in seen:
            unique_name = f"{name} ({suffix})"
            suffix += 1

        seen.add(unique_name)
        columns.append(unique_name)

    dataframe.columns = columns
    dataframe = dataframe.infer_objects()

    for column in dataframe.columns:
        dataframe[column] = to_numeric_if_possible(dataframe[column])

    return dataframe


def parse_spreadsheet(
    extension: str,
    content: bytes
) -> list[tuple[str, pd.DataFrame]]:
    """Read every sheet of an Excel or CSV file into clean DataFrames."""

    if extension in {".xlsx", ".xls"}:
        raw_sheets = pd.read_excel(
            BytesIO(content),
            sheet_name=None,
            header=None,
        )
    else:
        try:
            raw = pd.read_csv(BytesIO(content), header=None, encoding="utf-8-sig")
        except UnicodeDecodeError:
            raw = pd.read_csv(BytesIO(content), header=None, encoding="latin-1")

        raw_sheets = {"CSV Data": raw}

    sheets = []

    for sheet_name, raw in raw_sheets.items():
        dataframe = prepare_dataframe(raw)

        if not dataframe.empty:
            sheets.append((str(sheet_name), dataframe))

    return sheets


def format_row(row_number: int, row: dict) -> str:
    """Format a spreadsheet row as readable text for search and the AI."""

    values = [
        f"{column}: {clean_value(value)}"
        for column, value in row.items()
        if clean_value(value) != ""
    ]

    return f"Row {row_number}: " + " | ".join(values)


def sheet_chunks(
    filename: str,
    sheet_name: str,
    dataframe: pd.DataFrame
) -> list[tuple[str, str]]:
    """Create searchable (location, text) chunks from a sheet."""

    columns = ", ".join(dataframe.columns)
    chunks = [(
        f"Sheet {sheet_name} (overview)",
        f"Sheet '{sheet_name}' in {filename} has {len(dataframe)} rows. "
        f"Columns: {columns}.",
    )]

    header = f"Sheet: {sheet_name}\nColumns: {columns}\n"
    lines = []
    first_row = None
    last_row = None

    def flush():
        if lines:
            chunks.append((
                f"Sheet {sheet_name}, rows {first_row}–{last_row}",
                header + "\n".join(lines),
            ))

    indexed = dataframe.head(MAX_INDEXED_ROWS_PER_SHEET)

    # Spreadsheet row numbers start at 1, so the pandas index is offset by one.
    for index, row in zip(indexed.index, indexed.to_dict(orient="records")):
        row_number = int(index) + 1
        line = format_row(row_number, row)

        if lines and len(header) + sum(map(len, lines)) + len(line) > CHUNK_SIZE:
            flush()
            lines = []

        if not lines:
            first_row = row_number

        lines.append(line)
        last_row = row_number

    flush()

    return chunks


def sheet_as_text(sheet_name: str, dataframe: pd.DataFrame) -> str:
    return (
        f"--- Sheet: {sheet_name} ---\n"
        f"{dataframe.head(PREVIEW_ROWS).fillna('').to_string(index=False)}"
    )


# --------------------------------------------------
# EMBEDDINGS
# --------------------------------------------------

def embed(texts: list[str], kind: str) -> np.ndarray:
    """
    Embed texts with the local Ollama embedding model.
    nomic-embed-text expects different prefixes for documents and queries.
    """

    prefix = "search_query: " if kind == "query" else "search_document: "
    vectors = []

    try:
        for start in range(0, len(texts), EMBED_BATCH_SIZE):
            batch = texts[start:start + EMBED_BATCH_SIZE]
            response = requests.post(
                f"{OLLAMA_BASE_URL}/api/embed",
                json={
                    "model": EMBED_MODEL,
                    "input": [prefix + text for text in batch],
                    "truncate": True,
                },
                timeout=600,
            )

            if response.status_code == 404:
                raise RuntimeError(
                    f"The embedding model '{EMBED_MODEL}' is not installed in "
                    f"Ollama. Install it with: ollama pull {EMBED_MODEL}"
                )

            if response.status_code != 200:
                raise RuntimeError(
                    f"Embedding model returned HTTP {response.status_code}: "
                    f"{response.text[:300]}"
                )

            vectors.extend(response.json()["embeddings"])

    except requests.exceptions.ConnectionError as exc:
        raise RuntimeError(
            "Could not connect to Ollama. Please start Ollama and confirm "
            f"that the model '{EMBED_MODEL}' is installed."
        ) from exc

    matrix = np.array(vectors, dtype=np.float32)
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-12

    return matrix


# --------------------------------------------------
# ADDING AND REMOVING DOCUMENTS
# --------------------------------------------------

def sql_column_name(name: str, used: set[str]) -> str:
    """Make a safe, unique SQL column name from a spreadsheet heading."""

    base = re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower() or "column"

    if base[0].isdigit():
        base = "c_" + base

    candidate = base
    suffix = 2

    while candidate in used:
        candidate = f"{base}_{suffix}"
        suffix += 1

    used.add(candidate)

    return candidate


def sql_type(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_numeric_dtype(series):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "datetime (YYYY-MM-DD HH:MM:SS)"
    return "text"


def document_summary(row: sqlite3.Row, sheets: list[str]) -> dict:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "file_type": row["file_type"],
        "uploaded_at": row["uploaded_at"],
        "character_count": row["character_count"],
        "chunk_count": row["chunk_count"],
        "sheets": sheets,
    }


def add_document(filename: str, content: bytes) -> dict:
    """
    Parse, chunk, embed and store a document.
    Uploading the same file again returns the stored copy; uploading a
    changed file with the same name replaces the old version.
    """

    global _index_cache

    extension = get_extension(filename)

    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError("Unsupported file type. Upload PDF, XLSX, XLS or CSV.")

    sha256 = hashlib.sha256(content).hexdigest()

    with connect() as connection:
        existing = connection.execute(
            "SELECT * FROM documents WHERE sha256 = ?", (sha256,)
        ).fetchone()

    if existing:
        document = get_document(existing["id"])
        document["already_indexed"] = True
        return document

    chunks: list[tuple[str, str]] = []
    sheets: list[tuple[str, pd.DataFrame]] = []

    try:
        if extension == ".pdf":
            pages = parse_pdf(content)
            full_text = "\n\n".join(
                f"--- Page {number} ---\n{text}" for number, text in pages
            )

            for number, text in pages:
                for part in split_text(text):
                    chunks.append((f"page {number}", part))
        else:
            sheets = parse_spreadsheet(extension, content)
            full_text = "\n\n".join(
                sheet_as_text(name, dataframe) for name, dataframe in sheets
            )

            for name, dataframe in sheets:
                chunks.extend(sheet_chunks(filename, name, dataframe))

    except Exception as exc:
        raise ValueError(
            f"Could not read this document. Please check that the file "
            f"is valid and not password-protected. Details: {exc}"
        ) from exc

    if not chunks:
        raise ValueError(
            "No readable text was found in this document. "
            "If this is a scanned PDF, OCR support may be required."
        )

    started = time.perf_counter()
    embeddings = embed(
        [f"{filename}, {location}\n{text}" for location, text in chunks],
        kind="document",
    )
    print(
        f"[INDEX] {filename}: {len(chunks)} chunks embedded in "
        f"{time.perf_counter() - started:.1f}s"
    )

    with _write_lock, connect() as connection:
        # A new version of a file replaces the old one.
        for old in connection.execute(
            "SELECT id FROM documents WHERE filename = ?", (filename,)
        ).fetchall():
            _delete_document(connection, old["id"])

        cursor = connection.execute(
            """
            INSERT INTO documents
                (filename, file_type, sha256, uploaded_at,
                 character_count, chunk_count, full_text)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                filename,
                extension.lstrip("."),
                sha256,
                datetime.now(timezone.utc).isoformat(timespec="seconds"),
                len(full_text),
                len(chunks),
                full_text[:MAX_TEXT_LENGTH],
            ),
        )
        document_id = cursor.lastrowid

        connection.executemany(
            """
            INSERT INTO chunks (document_id, position, location, text, embedding)
            VALUES (?, ?, ?, ?, ?)
            """,
            [
                (document_id, position, location, text, vector.tobytes())
                for position, ((location, text), vector)
                in enumerate(zip(chunks, embeddings))
            ],
        )

        for index, (sheet_name, dataframe) in enumerate(sheets, start=1):
            table_name = f"sheet_{document_id}_{index}"
            used: set[str] = set()
            columns = [
                {
                    "name": sql_column_name(original, used),
                    "original": original,
                    "type": sql_type(dataframe[original]),
                }
                for original in dataframe.columns
            ]

            table = dataframe.copy()
            table.columns = [column["name"] for column in columns]
            table.to_sql(table_name, connection, index=False)

            connection.execute(
                """
                INSERT INTO sheets
                    (document_id, sheet_name, table_name, columns, row_count)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    sheet_name,
                    table_name,
                    json.dumps(columns, ensure_ascii=False),
                    len(dataframe),
                ),
            )

        _index_cache = None

    document = get_document(document_id)
    document["already_indexed"] = False

    return document


def _delete_document(connection: sqlite3.Connection, document_id: int) -> None:
    for sheet in connection.execute(
        "SELECT table_name FROM sheets WHERE document_id = ?", (document_id,)
    ).fetchall():
        connection.execute(f'DROP TABLE IF EXISTS "{sheet["table_name"]}"')

    connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))


def delete_document(document_id: int) -> bool:
    global _index_cache

    with _write_lock, connect() as connection:
        exists = connection.execute(
            "SELECT 1 FROM documents WHERE id = ?", (document_id,)
        ).fetchone()

        if not exists:
            return False

        _delete_document(connection, document_id)
        _index_cache = None

    return True


# --------------------------------------------------
# READING DOCUMENTS
# --------------------------------------------------

def list_documents() -> list[dict]:
    with connect() as connection:
        rows = connection.execute(
            "SELECT * FROM documents ORDER BY uploaded_at DESC, id DESC"
        ).fetchall()
        sheet_rows = connection.execute(
            "SELECT document_id, sheet_name FROM sheets ORDER BY id"
        ).fetchall()

    sheets: dict[int, list[str]] = {}

    for sheet in sheet_rows:
        sheets.setdefault(sheet["document_id"], []).append(sheet["sheet_name"])

    return [document_summary(row, sheets.get(row["id"], [])) for row in rows]


def get_document(document_id: int) -> Optional[dict]:
    return next(
        (doc for doc in list_documents() if doc["id"] == document_id),
        None,
    )


def get_preview(document_id: int) -> Optional[dict]:
    """Return the stored text, or the first rows of each sheet."""

    with connect() as connection:
        document = connection.execute(
            "SELECT * FROM documents WHERE id = ?", (document_id,)
        ).fetchone()

        if not document:
            return None

        sheet_rows = connection.execute(
            "SELECT * FROM sheets WHERE document_id = ? ORDER BY id",
            (document_id,),
        ).fetchall()

        sheets = []

        for sheet in sheet_rows:
            columns = json.loads(sheet["columns"])
            rows = connection.execute(
                f'SELECT * FROM "{sheet["table_name"]}" LIMIT {PREVIEW_ROWS}'
            ).fetchall()

            sheets.append({
                "sheet_name": sheet["sheet_name"],
                "columns": [column["original"] for column in columns],
                "rows": [
                    {
                        column["original"]: clean_value(row[column["name"]])
                        for column in columns
                    }
                    for row in rows
                ],
                "total_rows": sheet["row_count"],
                "truncated": sheet["row_count"] > PREVIEW_ROWS,
            })

    return {
        **document_summary(document, [sheet["sheet_name"] for sheet in sheets]),
        "text": document["full_text"] if not sheets else "",
        "structured_data": sheets,
    }


# --------------------------------------------------
# SEARCH
# --------------------------------------------------

def _load_index() -> dict:
    """Load all chunk embeddings into memory once, until data changes."""

    global _index_cache

    with _index_lock:
        if _index_cache is None:
            with connect() as connection:
                rows = connection.execute(
                    "SELECT id, document_id, embedding FROM chunks ORDER BY id"
                ).fetchall()

            if rows:
                matrix = np.vstack([
                    np.frombuffer(row["embedding"], dtype=np.float32)
                    for row in rows
                ])
            else:
                matrix = np.zeros((0, 0), dtype=np.float32)

            _index_cache = {
                "chunk_ids": np.array([row["id"] for row in rows]),
                "document_ids": np.array([row["document_id"] for row in rows]),
                "matrix": matrix,
            }

        return _index_cache


def _fetch_chunks(chunk_ids: list[int]) -> dict[int, dict]:
    if not chunk_ids:
        return {}

    placeholders = ",".join("?" * len(chunk_ids))

    with connect() as connection:
        rows = connection.execute(
            f"""
            SELECT chunks.id, chunks.document_id, chunks.position,
                   chunks.location, chunks.text, documents.filename
            FROM chunks JOIN documents ON documents.id = chunks.document_id
            WHERE chunks.id IN ({placeholders})
            """,
            chunk_ids,
        ).fetchall()

    return {row["id"]: dict(row) for row in rows}


def search(
    question: str,
    document_ids: Optional[list[int]] = None,
    limit: int = 8
) -> list[dict]:
    """
    Find the chunks most relevant to a question. Relevance combines
    meaning (embedding similarity) with exact word matches, which helps
    with names, codes and numbers that embeddings handle poorly.
    """

    index = _load_index()

    if len(index["chunk_ids"]) == 0:
        return []

    mask = np.ones(len(index["chunk_ids"]), dtype=bool)

    if document_ids:
        mask = np.isin(index["document_ids"], document_ids)

    if not mask.any():
        return []

    query_vector = embed([question], kind="query")[0]
    similarities = index["matrix"] @ query_vector
    similarities[~mask] = -1.0

    candidate_count = min(50, int(mask.sum()))
    candidates = np.argsort(-similarities)[:candidate_count]
    chunks = _fetch_chunks([int(index["chunk_ids"][i]) for i in candidates])

    terms = get_query_terms(question)
    results = []

    for position in candidates:
        chunk = chunks.get(int(index["chunk_ids"][position]))

        if not chunk:
            continue

        lowered = chunk["text"].lower()
        keyword_score = (
            sum(1 for term in terms if term in lowered) / len(terms)
            if terms else 0.0
        )

        chunk["score"] = round(
            float(similarities[position]) + KEYWORD_WEIGHT * keyword_score, 4
        )
        results.append(chunk)

    results.sort(key=lambda chunk: -chunk["score"])

    return [
        chunk for chunk in results[:limit]
        if chunk["score"] >= MIN_RELEVANCE
    ]


def sample_chunks(
    document_ids: Optional[list[int]] = None,
    limit: int = 8
) -> list[dict]:
    """
    Pick evenly spaced chunks from each document, for broad requests
    such as "summarize this document" that have no search terms.
    """

    with connect() as connection:
        if document_ids:
            placeholders = ",".join("?" * len(document_ids))
            rows = connection.execute(
                f"SELECT id, chunk_count FROM documents "
                f"WHERE id IN ({placeholders}) ORDER BY id",
                document_ids,
            ).fetchall()
        else:
            rows = connection.execute(
                "SELECT id, chunk_count FROM documents ORDER BY id"
            ).fetchall()

        rows = rows[:limit]

        if not rows:
            return []

        per_document = max(1, limit // len(rows))
        chunk_ids = []

        for row in rows:
            count = row["chunk_count"]
            positions = sorted({
                int(i * count / per_document) for i in range(per_document)
            })
            placeholders = ",".join("?" * len(positions))

            chunk_ids.extend(
                chunk["id"] for chunk in connection.execute(
                    f"SELECT id FROM chunks WHERE document_id = ? "
                    f"AND position IN ({placeholders}) ORDER BY position",
                    [row["id"], *positions],
                ).fetchall()
            )

    chunks = _fetch_chunks(chunk_ids)

    return [
        {**chunks[chunk_id], "score": None}
        for chunk_id in chunk_ids if chunk_id in chunks
    ]


# --------------------------------------------------
# SPREADSHEET SQL
# --------------------------------------------------

MAX_LISTED_VALUES = 100
IDENTIFIER_PATTERN = re.compile(r"(^|_)(name|code|id|no|number|emp|employee)(_|$)")


def describe_columns(
    connection: sqlite3.Connection,
    table_name: str,
    columns: list[dict]
) -> list[dict]:
    """
    Add the full list of values for text columns with few distinct values
    (departments, designations, regions...), so the model can match a
    question to the exact spelling used in the sheet.
    """

    described = []

    for column in columns:
        column = dict(column)

        if column["type"] == "text":
            values = [
                row[0] for row in connection.execute(
                    f'SELECT DISTINCT "{column["name"]}" FROM "{table_name}" '
                    f'WHERE "{column["name"]}" IS NOT NULL '
                    f'AND "{column["name"]}" != \'\' '
                    f"LIMIT {MAX_LISTED_VALUES + 1}"
                )
            ]

            if len(values) <= MAX_LISTED_VALUES:
                column["values"] = [str(value) for value in values]

        described.append(column)

    return described


def identifying_columns(columns: list[dict]) -> list[str]:
    """Columns that identify a record, such as an employee code and name."""

    return [
        column["name"] for column in columns
        if column["type"] == "text"
        and "values" not in column
        and IDENTIFIER_PATTERN.search(column["name"])
    ][:3]


def get_sheet_schemas(document_ids: Optional[list[int]] = None) -> list[dict]:
    """Describe every spreadsheet table and its columns."""

    query = (
        "SELECT sheets.*, documents.filename FROM sheets "
        "JOIN documents ON documents.id = sheets.document_id"
    )
    parameters: list[Any] = []

    if document_ids:
        query += f" WHERE sheets.document_id IN ({','.join('?' * len(document_ids))})"
        parameters = list(document_ids)

    schemas = []

    with connect() as connection:
        for sheet in connection.execute(query + " ORDER BY sheets.id", parameters).fetchall():
            columns = describe_columns(
                connection,
                sheet["table_name"],
                json.loads(sheet["columns"]),
            )

            schemas.append({
                "document_id": sheet["document_id"],
                "filename": sheet["filename"],
                "sheet_name": sheet["sheet_name"],
                "table_name": sheet["table_name"],
                "columns": columns,
                "identifying_columns": identifying_columns(columns),
                "row_count": sheet["row_count"],
            })

    return schemas


def columns_containing(
    schema: dict,
    value: str,
    partial: bool = False
) -> list[str]:
    """Return the text columns of a table that contain a value."""

    operator = "LIKE" if partial else "="
    found = []

    with connect() as connection:
        for column in schema["columns"]:
            if column["type"] != "text":
                continue

            match = connection.execute(
                f'SELECT 1 FROM "{schema["table_name"]}" '
                f'WHERE LOWER("{column["name"]}") {operator} LOWER(?) LIMIT 1',
                (value,),
            ).fetchone()

            if match:
                found.append(column["name"])

    return found


def rank_tables(question: str, schemas: list[dict]) -> list[dict]:
    """
    Score each table by how well it matches the question: words that
    appear as cell values (e.g. "MCS-M1") count most, column names less.
    Returns the schemas with "value_hits" and "column_hits" added,
    best match first.
    """

    # Short words ("see", "all") match too many cells to mean anything.
    terms = [
        term for term in get_query_terms(question)
        if len(term) >= 4 or re.search(r"\d", term)
    ]
    ranked = []

    with connect() as connection:
        for schema in schemas:
            text_columns = [
                column["name"] for column in schema["columns"]
                if column["type"] == "text"
            ]
            column_words = " ".join(
                f'{column["name"]} {column["original"]}'.lower()
                for column in schema["columns"]
            )

            value_hits = 0

            for term in terms:
                if not text_columns:
                    break

                condition = " OR ".join(
                    f'LOWER("{name}") LIKE ?' for name in text_columns
                )
                found = connection.execute(
                    f'SELECT 1 FROM "{schema["table_name"]}" WHERE {condition} LIMIT 1',
                    [f"%{term}%"] * len(text_columns),
                ).fetchone()

                value_hits += bool(found)

            column_hits = sum(1 for term in terms if term in column_words)

            ranked.append({
                **schema,
                "value_hits": value_hits,
                "column_hits": column_hits,
            })

    ranked.sort(key=lambda schema: (-schema["value_hits"], -schema["column_hits"]))

    return ranked


def run_readonly_query(sql: str, allowed_tables: set[str]) -> dict:
    """
    Run an AI-written query safely: a single SELECT, on a read-only
    connection, limited to the given spreadsheet tables and a time budget.
    """

    sql = sql.strip().rstrip(";").strip()

    if ";" in sql:
        raise ValueError("Only a single SQL statement is allowed.")

    if not re.match(r"^(select|with)\b", sql, re.IGNORECASE):
        raise ValueError("Only SELECT queries are allowed.")

    def authorizer(action, arg1, arg2, database, source):
        if action == sqlite3.SQLITE_READ:
            return sqlite3.SQLITE_OK if arg1 in allowed_tables else sqlite3.SQLITE_DENY
        if action in (
            sqlite3.SQLITE_SELECT,
            sqlite3.SQLITE_FUNCTION,
            sqlite3.SQLITE_RECURSIVE,
        ):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY

    deadline = time.monotonic() + SQL_TIMEOUT_SECONDS
    connection = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)

    try:
        connection.set_authorizer(authorizer)
        connection.set_progress_handler(
            lambda: 1 if time.monotonic() > deadline else 0, 10_000
        )

        cursor = connection.execute(sql)
        columns = [description[0] for description in cursor.description or []]
        rows = cursor.fetchmany(SQL_MAX_ROWS + 1)
    finally:
        connection.close()

    return {
        "columns": columns,
        "rows": [[clean_value(value) for value in row] for row in rows[:SQL_MAX_ROWS]],
        "truncated": len(rows) > SQL_MAX_ROWS,
    }


def installed_models() -> set[str]:
    """Report whether Ollama is running and which models are installed."""

    response = requests.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=5)
    response.raise_for_status()

    return {
        model.get("name", "")
        for model in response.json().get("models", [])
    }
