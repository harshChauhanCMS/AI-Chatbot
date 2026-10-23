# DocuMind — AI Document Explainer

A chatbot that answers questions using only the PDF, Excel and CSV files an
admin uploads. Everything runs locally with free models through
[Ollama](https://ollama.com); no data is sent to a cloud AI service.

- `index.html` — public chat page
- `admin.html` — admin page to upload, preview and remove documents (password protected)
- `backend/` — FastAPI API, knowledge base (SQLite in `backend/data/`) and AI prompts

## Requirements

- Python 3.11+
- Ollama, with these two models pulled:

```bash
ollama pull nomic-embed-text   # embeddings for searching documents
ollama pull llama3.2:3b        # answers questions
ollama list                    # both should be listed
```

If an upload fails with `"nomic-embed-text" not found` (or a question fails with
`"llama3.2:3b" not found`), that model has not been pulled yet.

## Setup

```bash
cd document-explainer/backend
python3 -m venv venv
venv/bin/pip install -r requirement.txt
cp .env.example .env           # then set ADMIN_PASSWORD in .env
```

## Run

Three terminals:

```bash
ollama serve                                   # skip if the Ollama app is already running

cd document-explainer/backend
venv/bin/uvicorn main:app --port 8000 --reload

cd document-explainer
python3 -m http.server 5500
```

- Chat: http://127.0.0.1:5500/
- Admin: http://127.0.0.1:5500/admin.html (password from `backend/.env`)

The pages must be served on port 5500 locally: `common.js` uses that port to
find the API on `127.0.0.1:8000`, and the backend's CORS settings only allow it.
When deployed, the pages and the API are served from the same address.

## Configuration (`backend/.env`)

| Setting | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | — (required) | Password for the admin page |
| `OLLAMA_MODEL` | `llama3.2:3b` | Model that answers questions |
| `EMBED_MODEL` | `nomic-embed-text` | Model that indexes documents for search |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server |
| `MIN_RELEVANCE` | `0.6` | How closely document text must match a question |

Changing `EMBED_MODEL` requires re-uploading documents, because stored
embeddings are tied to the model that created them.

## How answers work

- **Spreadsheets**: each sheet is stored as a SQL table. Questions that name
  values from a sheet (e.g. a department) or ask for counts/totals/lists are
  answered by a generated, read-only SQL query that is checked before it runs
  (no invented filter values, values must exist in the filtered column).
- **Other text (PDFs)**: the closest passages are found by embedding search and
  the model answers only from them, or says it couldn't find the answer.

## Deployment (current server)

- Code: `/opt/documind/web` (public pages) and `/opt/documind/backend`
- Service: `systemctl status documind` (uvicorn on `127.0.0.1:8765`)
- Web server: Caddy block `documind.72.61.239.56.nip.io` in `/etc/caddy/Caddyfile`
