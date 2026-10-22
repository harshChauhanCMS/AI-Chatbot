
import requests
import pandas as pd
import pymupdf

from io import BytesIO
from pydantic import BaseModel
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware


# --------------------------------------------------
# 1. Create FastAPI application
# --------------------------------------------------

app = FastAPI(title="AI Document Explainer API")


# --------------------------------------------------
# 2. Configure CORS for frontend
# --------------------------------------------------

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


# --------------------------------------------------
# 3. Home and health endpoints
# --------------------------------------------------

@app.get("/")
def home():
    return {
        "message": "AI Document Explainer backend is running!"
    }


@app.get("/api/health")
def health():
    return {"status": "healthy"}


# --------------------------------------------------
# 4. Extract text from PDF, Excel and CSV files
# --------------------------------------------------

def extract_document_content(filename, content):
    extension = filename.lower().rsplit(".", 1)[-1]

    if extension == "pdf":
        with pymupdf.open(
            stream=content,
            filetype="pdf"
        ) as document:
            text = "\n".join(
                page.get_text() for page in document
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
            parts.append(dataframe.to_string(index=False))

        return "\n\n".join(parts)

    if extension == "csv":
        dataframe = pd.read_csv(BytesIO(content))
        return dataframe.to_string(index=False)

    raise ValueError(
        "Unsupported file type. Upload PDF, XLSX, XLS, or CSV."
    )


# --------------------------------------------------
# 5. Upload and process a document
# --------------------------------------------------

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
        "truncated": False
    }


# --------------------------------------------------
# 6. Request model for asking questions
# --------------------------------------------------

class AskRequest(BaseModel):
    question: str
    document_content: str


# --------------------------------------------------
# 7. Send document content and question to Ollama
# --------------------------------------------------


def ask_local_llm(question: str, document_content: str) -> str:
    try:
        # Send a smaller amount of document text to speed up processing
        limited_content = document_content[:5000]

        response = requests.post(
            "http://localhost:11434/api/chat",
            json={
                "model": "llama3.2:3b",
                "stream": False,
                "keep_alive": "5m",
                "options": {
                    "num_predict": 256,
                    "num_ctx": 4096,
                    "temperature": 0.2
                },
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are an AI document explainer. "
                            "Answer using the supplied document. "
                          
                            "Use simple language and concise answers. "
                            "If the answer is not present in the supplied "
                            "text, say so clearly. Do not invent facts."
                        )
                    },
                    {
                        "role": "user",
                        "content": (
                            f"DOCUMENT CONTENT:\n{limited_content}\n\n"
                            f"QUESTION:\n{question}"
                        )
                    }
                ]
            },
            timeout=300
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
            )
        ) from error

    except requests.RequestException as error:
        raise HTTPException(
            status_code=502,
            detail=(
                "Could not connect to Ollama. "
                "Check that Ollama is running and llama3.2:3b is installed."
            )
        ) from error

    except (KeyError, ValueError) as error:
        raise HTTPException(
            status_code=502,
            detail="Received an invalid response from the AI model."
        ) from error


# --------------------------------------------------
# 8. Ask questions about the uploaded document
# --------------------------------------------------

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

    answer = ask_local_llm(
        question,
        document_content
    )

    return {"answer": answer}
