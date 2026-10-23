// Shared helpers for the chat page (script.js) and the admin page (admin.js).

// Locally the pages are served on :5500 and the API runs on :8000;
// when deployed, the web server serves both from the same address.
const API_URL = window.location.port === "5500" ? "http://127.0.0.1:8000" : "";

async function apiRequest(path, options = {}) {
  let response;

  try {
    response = await fetch(`${API_URL}${path}`, options);
  } catch {
    throw new Error(
      "Cannot reach the backend. Make sure it is running on port 8000."
    );
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.detail || `Request failed (HTTP ${response.status}).`
    );
    error.status = response.status;
    throw error;
  }

  return data;
}

function createTable(columns, rows) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-scroll";

  const table = document.createElement("table");
  table.className = "result-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = String(column ?? "");
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  rows.forEach((row) => {
    const tr = document.createElement("tr");

    columns.forEach((column, index) => {
      const td = document.createElement("td");
      const value = Array.isArray(row) ? row[index] : row[column];

      td.textContent = value === null || value === undefined ? "" : String(value);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrapper.appendChild(table);

  return wrapper;
}

// Show backend and model status in a pill element.
async function checkHealth(pill, label) {
  try {
    const health = await apiRequest("/api/health");

    pill.classList.toggle("warning", health.status !== "ok");

    if (!health.ollama_connected) {
      label.textContent = "Ollama is not running";
    } else if (!health.model_available) {
      label.textContent = `Model ${health.model} missing`;
    } else if (!health.embedding_model_available) {
      label.textContent = `Model ${health.embedding_model} missing`;
    } else {
      label.textContent = "Assistant ready";
    }
  } catch {
    pill.classList.add("warning");
    label.textContent = "Assistant offline";
  }
}
