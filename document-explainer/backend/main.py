
import re
from io import BytesIO
from typing import Any, Optional

import pandas as pd
import pymupdf
import requests
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ==================================================
# 1. FASTAPI APPLICATION
# ==================================================

app = FastAPI(title="AI Document Explainer - HR Assistant")


# ==================================================
# 2. CORS CONFIGURATION
# ==================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5501",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==================================================
# 3. HOME AND HEALTH ENDPOINTS
# ==================================================

@app.get("/")
def home():
    return {
        "message": "AI Document Explainer backend is running!"
    }


@app.get("/api/health")
def health():
    return {"status": "healthy"}


# ==================================================
# 4. CONVERT DATAFRAME VALUES TO JSON-SAFE VALUES
# ==================================================

def clean_value(value: Any):
    if value is None:
        return None

    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass

    if hasattr(value, "isoformat"):
        return value.isoformat()

    if hasattr(value, "item"):
        value = value.item()

    if isinstance(value, (str, int, float, bool)):
        return value

    return str(value)


def dataframe_to_records(dataframe):
    dataframe = dataframe.copy()
    dataframe.columns = [
        str(column).strip()
        for column in dataframe.columns
    ]

    records = []

    for row in dataframe.to_dict(orient="records"):
        records.append({
            str(key): clean_value(value)
            for key, value in row.items()
        })

    return records


# ==================================================
# 5. EXTRACT TEXT FROM PDF, EXCEL AND CSV
# ==================================================

def extract_document_content(filename, content):
    extension = filename.lower().rsplit(".", 1)[-1]

    if extension == "pdf":
        with pymupdf.open(
            stream=content,
            filetype="pdf"
        ) as document:
            text = "\n".join(
                page.get_text()
                for page in document
            )

        if not text.strip():
            raise ValueError(
                "No readable text found in PDF. "
                "It may be a scanned document."
            )

        return text

    if extension in ["xlsx", "xls"]:
        sheets = pd.read_excel(
            BytesIO(content),
            sheet_name=None
        )

        parts = []

        for sheet_name, dataframe in sheets.items():
            parts.append(f"Sheet: {sheet_name}")
            parts.append(
                dataframe.to_string(index=False)
            )

        return "\n\n".join(parts)

    if extension == "csv":
        dataframe = pd.read_csv(BytesIO(content))
        return dataframe.to_string(index=False)

    raise ValueError(
        "Unsupported file type. Upload PDF, XLSX, XLS, or CSV."
    )


# ==================================================
# 6. EXTRACT STRUCTURED DATA FROM EXCEL AND CSV
# ==================================================

def extract_structured_data(filename, content):
    extension = filename.lower().rsplit(".", 1)[-1]

    if extension in ["xlsx", "xls"]:
        dataframes = pd.read_excel(
            BytesIO(content),
            sheet_name=None
        )

    elif extension == "csv":
        dataframes = {
            "CSV Data": pd.read_csv(BytesIO(content))
        }

    else:
        # PDF text is supported, but structured PDF-table
        # extraction is not implemented in this version.
        return []

    structured_sheets = []

    for sheet_name, dataframe in dataframes.items():
        dataframe = dataframe.dropna(how="all").fillna("")

        dataframe.columns = [
            str(column).strip()
            for column in dataframe.columns
        ]

        # Limit structured results to 5,000 rows per sheet.
        limited_dataframe = dataframe.head(5000)

        structured_sheets.append({
            "sheet_name": str(sheet_name),
            "columns": [
                str(column)
                for column in limited_dataframe.columns
            ],
            "rows": dataframe_to_records(limited_dataframe),
            "truncated": len(dataframe) > 5000,
        })

    return structured_sheets


# ==================================================
# 7. UPLOAD DOCUMENT ENDPOINT
# ==================================================

@app.post("/api/upload")
async def upload_document(file: UploadFile = File(...)):
    allowed_extensions = {"pdf", "xlsx", "xls", "csv"}
    filename = file.filename or ""

    if "." not in filename:
        raise HTTPException(
            status_code=400,
            detail="Please upload a supported document."
        )

    extension = filename.rsplit(".", 1)[-1].lower()

    if extension not in allowed_extensions:
        raise HTTPException(
            status_code=400,
            detail="Supported formats: PDF, XLSX, XLS, CSV."
        )

    content = await file.read()

    if not content:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty."
        )

    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail="File size must be 10 MB or less."
        )

    try:
        extracted_text = extract_document_content(
            filename,
            content
        )

        structured_data = extract_structured_data(
            filename,
            content
        )

    except Exception as error:
        raise HTTPException(
            status_code=400,
            detail=f"Could not read document: {error}"
        ) from error

    finally:
        await file.close()

    return {
        "filename": filename,
        "status": "success",
        "message": "Document uploaded and processed.",
        "character_count": len(extracted_text),
        "extracted_content": extracted_text,
        "truncated": False,
        "structured_data": structured_data,
    }


# ==================================================
# 8. QUESTION REQUEST MODEL
# ==================================================

class AskRequest(BaseModel):
    question: str
    document_content: str
    structured_data: Optional[list[dict]] = None


# ==================================================
# 9. IDENTIFY SPREADSHEET COLUMNS
# ==================================================

def normalize_column(column):
    return re.sub(
        r"[^a-z0-9]",
        "",
        str(column).lower()
    )


def find_salary_column(columns):
    preferred_names = {
        "salary",
        "monthlysalary",
        "employeesalary",
        "salaryinr",
        "salaryamount",
        "annualsalary",
        "ctc",
        "pay",
        "salarypackage",
    }

    for column in columns:
        if normalize_column(column) in preferred_names:
            return column

    for column in columns:
        normalized = normalize_column(column)

        if "salary" in normalized or normalized == "ctc":
            return column

    return None


def find_role_columns(columns):
    keywords = (
        "designation",
        "role",
        "jobtitle",
        "jobrole",
        "position",
        "department",
        "work",
        "profession",
        "team",
        "function",
    )

    return [
        column
        for column in columns
        if any(
            keyword in normalize_column(column)
            for keyword in keywords
        )
    ]


# ==================================================
# 10. UNDERSTAND SALARY CONDITIONS
# ==================================================

def parse_salary_condition(question):
    q = question.lower()
    q = q.replace(",", "")
    q = q.replace("₹", "")
    q = q.replace("greater then", "greater than")
    q = q.replace("less then", "less than")
    q = q.replace("higher then", "higher than")
    q = q.replace("lower then", "lower than")

    patterns = [
        (
            r"\b(?:less than|below|under|lower than)"
            r"\s*(?:(?:rs\.?|inr)\s*)?(\d+(?:\.\d+)?)",
            "lt",
        ),
        (
            r"\b(?:greater than|more than|above|over|higher than)"
            r"\s*(?:(?:rs\.?|inr)\s*)?(\d+(?:\.\d+)?)",
            "gt",
        ),
        (
            r"\b(?:equal to|equals?|exactly)"
            r"\s*(?:(?:rs\.?|inr)\s*)?(\d+(?:\.\d+)?)",
            "eq",
        ),
    ]

    for pattern, operator in patterns:
        match = re.search(pattern, q)

        if match:
            return operator, float(match.group(1))

    return None



# ==================================================
# 11. IDENTIFY ROLE AND DEPARTMENT QUESTIONS
# ==================================================

def extract_role_keyword(question):
    q = question.lower().strip()
    q = re.sub(r"[?!.,]+", " ", q)
    q = re.sub(r"\s+", " ", q)

    patterns = [
        # Examples:
        # "HR department members"
        # "details of HR department"
        # "employees in HR department"
        r"\b(?:of|in|from)\s+(?:the\s+)?"
        r"([a-z][a-z &-]*?)\s+department\b",

        # Examples:
        # "work as a recruiter"
        r"\b(?:work|works|working)\s+as\s+"
        r"(?:a\s+|an\s+|the\s+)?(.+)",

        # Examples:
        # "role HR Assistant"
        # "designation is Recruiter"
        r"\b(?:designation|job title|job role|role)"
        r"\s+(?:is|as|of)?\s*(.+)",

        # Examples:
        # "in HR"
        # "from HR"
        r"\b(?:in|from)\s+(?:the\s+)?"
        r"([a-z][a-z &-]*)\s+"
        r"(?:department\s+)?"
        r"(?:members|employees|staff|team|people)\b",
    ]

    for pattern in patterns:
        match = re.search(pattern, q)

        if not match:
            continue

        phrase = match.group(1).strip(" .?!,")

        # Remove unnecessary words around the requested value.
        phrase = re.sub(
            r"^(?:the|a|an)\s+",
            "",
            phrase
        ).strip()

        phrase = re.sub(
            r"\s+(?:department|members|employees|staff|team|people)$",
            "",
            phrase
        ).strip()

        phrase = re.split(
            r"\b(?:and whose|and salary|with salary|whose salary|"
            r"earning|salary|with experience)\b",
            phrase,
            maxsplit=1
        )[0].strip()

        if phrase and len(phrase) >= 2:
            return phrase

    return None


def row_matches_role(row, role_columns, keyword):
    if not keyword:
        return True

    if not role_columns:
        return False

    keyword = keyword.strip().lower()

    for column in role_columns:
        value = str(row.get(column, "")).strip().lower()

        if keyword in value:
            return True

    return False


# ==================================================
# 12. FILTER EMPLOYEE DATA
# ==================================================

def filter_employee_data(question, structured_data):
    salary_condition = parse_salary_condition(question)
    role_keyword = extract_role_keyword(question)

    if not salary_condition and not role_keyword:
        return None

    all_columns = []
    all_rows = []
    salary_column_found = False
    role_column_found = False

    for sheet in structured_data or []:
        columns = sheet.get("columns", [])
        rows = sheet.get("rows", [])

        if not columns:
            continue

        salary_column = find_salary_column(columns)
        role_columns = find_role_columns(columns)

        if salary_column:
            salary_column_found = True

        if role_columns:
            role_column_found = True

        for column in columns:
            if column not in all_columns:
                all_columns.append(column)

        if salary_condition and not salary_column:
            continue

        if role_keyword and not role_columns:
            continue

        for row in rows:
            # Filter by salary when requested.
            if salary_condition:
                raw_salary = row.get(salary_column)

                try:
                    salary_text = (
                        str(raw_salary)
                        .replace(",", "")
                        .replace("₹", "")
                        .strip()
                    )
                    salary = float(salary_text)

                except (TypeError, ValueError):
                    continue

                operator, threshold = salary_condition

                if operator == "lt" and salary >= threshold:
                    continue

                if operator == "gt" and salary <= threshold:
                    continue

                if operator == "eq" and salary != threshold:
                    continue

            # Filter by role or department.
            if not row_matches_role(
                row,
                role_columns,
                role_keyword
            ):
                continue

            all_rows.append(row)

    if salary_condition and not salary_column_found:
        return {
            "answer": (
                "I couldn't find a salary column. "
                "Please check for a Salary or CTC column."
            ),
            "table": {"columns": [], "rows": []}
        }

    if role_keyword and not role_column_found:
        return {
            "answer": (
                "I couldn't find a role or department column. "
                "Please check for a Department, Role, "
                "Designation, or Position column."
            ),
            "table": {"columns": [], "rows": []}
        }

    criteria = []

    if role_keyword:
        criteria.append(
            f"'{role_keyword}' in the role or department fields"
        )

    if salary_condition:
        operator, amount = salary_condition

        label = {
            "lt": "less than",
            "gt": "greater than",
            "eq": "equal to"
        }[operator]

        criteria.append(f"salary {label} {amount:g}")

    description = " and ".join(criteria)

    if not all_rows:
        return {
            "answer": f"No employees found matching {description}.",
            "table": {
                "columns": all_columns,
                "rows": []
            }
        }

    return {
        "answer": (
            f"Found {len(all_rows)} employee(s) matching "
            f"{description}. Their details are shown below."
        ),
        "table": {
            "columns": all_columns,
            "rows": all_rows
        }
    }



# ==================================================
# 13. ASK OLLAMA FOR GENERAL DOCUMENT QUESTIONS
# ==================================================

def ask_local_llm(question: str, document_content: str) -> str:
    limited_content = document_content[:5000]

    try:
        response = requests.post(
            "http://localhost:11434/api/chat",
            json={
                "model": "llama3.2:3b",
                "stream": False,
                "keep_alive": "5m",
                "options": {
                    "num_predict": 256,
                    "num_ctx": 4096,
                    "temperature": 0.2,
                },
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are a professional HR Assistant and document explainer. "
                            "Answer using only the supplied document. "
                            "Use clear, polite, concise language. "
                            "Never invent employee names, salaries, or roles. "
                            "If the answer is not in the document, say so clearly."
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"DOCUMENT CONTENT:\n{limited_content}\n\n"
                            f"QUESTION:\n{question}"
                        ),
                    },
                ],
            },
            timeout=300,
        )

        response.raise_for_status()

        result = response.json()
        answer = result["message"]["content"].strip()

        if not answer:
            raise HTTPException(
                status_code=502,
                detail="The AI model returned an empty answer."
            )

        return answer

    except requests.Timeout as error:
        raise HTTPException(
            status_code=504,
            detail=(
                "The AI model took too long to respond. "
                "Try a shorter question or check your computer's resources."
            ),
        ) from error

    except requests.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=(
                "Could not connect to Ollama. Check that Ollama is running "
                "and llama3.2:3b is installed."
            ),
        ) from error

    except (KeyError, ValueError) as error:
        raise HTTPException(
            status_code=502,
            detail="Received an invalid response from the AI model."
        ) from error



# ==================================================
# 14. ASK DOCUMENT ENDPOINT
# ==================================================

@app.post("/api/ask")
def ask_document(request: AskRequest):
    question = request.question.strip()
    document_content = request.document_content.strip()

    if not question:
        raise HTTPException(
            status_code=400,
            detail="Please enter a question."
        )

    if not document_content:
        raise HTTPException(
            status_code=400,
            detail="Please upload a document first."
        )

    # First, filter real Excel/CSV records when possible.
    filtered_result = filter_employee_data(
        question,
        request.structured_data or []
    )

    if filtered_result is not None:
        return filtered_result

    # For other questions, use the local Ollama model.
    answer = ask_local_llm(
        question,
        document_content
    )

    return {
        "answer": answer,
        "table": None
    }
