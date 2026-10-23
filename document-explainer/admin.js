// Admin page: sign in, then add, preview and remove knowledge base documents.

const loginSection = document.getElementById("loginSection");
const loginForm = document.getElementById("loginForm");
const passwordInput = document.getElementById("password");
const loginButton = document.getElementById("loginButton");
const loginStatus = document.getElementById("loginStatus");
const adminSection = document.getElementById("adminSection");
const logoutButton = document.getElementById("logoutButton");
const fileInput = document.getElementById("document");
const browseButton = document.getElementById("browseButton");
const fileInfo = document.getElementById("fileInfo");
const sheetUrl = document.getElementById("sheetUrl");
const connectSheet = document.getElementById("connectSheet");
const statusText = document.getElementById("status");
const extractedData = document.getElementById("extractedData");
const documentDataInfo = document.getElementById("documentDataInfo");
const dropzone = document.getElementById("dropzone");
const dataBadge = document.getElementById("dataBadge");
const libraryList = document.getElementById("libraryList");
const libraryEmpty = document.getElementById("libraryEmpty");
const libraryBadge = document.getElementById("libraryBadge");
const backendPill = document.getElementById("backendPill");
const backendStatus = document.getElementById("backendStatus");

const TOKEN_KEY = "documind-admin-token";
const allowedExtensions = ["pdf", "xlsx", "xls", "csv"];

let adminToken = readStoredToken();
let documents = [];
let previewedDocumentId = null;
let uploading = false;

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function setDataBadge(message, ready) {
  dataBadge.textContent = message;
  dataBadge.classList.toggle("ready", ready);
}

// STEP 1: Admin session
// The token lives in sessionStorage, so closing the tab signs out.
function readStoredToken() {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token) {
  adminToken = token;

  try {
    if (token) {
      window.sessionStorage.setItem(TOKEN_KEY, token);
    } else {
      window.sessionStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // The page still works for this visit without storage.
  }
}

function showLogin(message = "", isError = false) {
  storeToken("");
  adminSection.hidden = true;
  logoutButton.hidden = true;
  loginSection.hidden = false;
  loginStatus.textContent = message;
  loginStatus.classList.toggle("error", isError);
  passwordInput.focus();
}

function showAdmin() {
  loginSection.hidden = true;
  adminSection.hidden = false;
  logoutButton.hidden = false;
  loadDocuments();
}

async function adminRequest(path, options = {}) {
  try {
    return await apiRequest(path, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: `Bearer ${adminToken}`,
      },
    });
  } catch (error) {
    if (error.status === 401) {
      showLogin("Your session has expired. Please sign in again.", true);
    }

    throw error;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  loginButton.disabled = true;
  loginStatus.textContent = "Signing in…";
  loginStatus.classList.remove("error");

  try {
    const data = await apiRequest("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordInput.value }),
    });

    passwordInput.value = "";
    storeToken(data.token);
    showAdmin();
  } catch (error) {
    loginStatus.textContent = error.message;
    loginStatus.classList.add("error");
  } finally {
    loginButton.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  try {
    await adminRequest("/api/admin/logout", { method: "POST" });
  } catch {
    // Sign out locally even if the backend is unreachable.
  }

  showLogin("You have been signed out.");
});

// STEP 2: Document list
function describeDocument(doc) {
  if (doc.sheets.length > 0) {
    const label = doc.sheets.length === 1 ? "sheet" : "sheets";
    return `${doc.file_type.toUpperCase()} · ${doc.sheets.length} ${label}`;
  }

  return `${doc.file_type.toUpperCase()} · ${doc.chunk_count} sections`;
}

function renderLibrary() {
  libraryList.replaceChildren();
  libraryEmpty.hidden = documents.length > 0;
  libraryBadge.textContent =
    `${documents.length} file${documents.length === 1 ? "" : "s"}`;
  libraryBadge.classList.toggle("ready", documents.length > 0);

  documents.forEach((doc) => {
    const item = document.createElement("li");
    item.className = "library-item";
    item.classList.toggle("active", doc.id === previewedDocumentId);

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "library-open";
    openButton.title = "Preview this document";

    const name = document.createElement("span");
    name.className = "library-name";
    name.textContent = doc.filename;

    const meta = document.createElement("span");
    meta.className = "library-meta";
    meta.textContent = describeDocument(doc);

    openButton.append(name, meta);
    openButton.addEventListener("click", () => previewDocument(doc.id));

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "library-delete";
    deleteButton.title = `Remove ${doc.filename}`;
    deleteButton.setAttribute("aria-label", `Remove ${doc.filename}`);
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", () => removeDocument(doc));

    item.append(openButton, deleteButton);
    libraryList.appendChild(item);
  });
}

async function loadDocuments() {
  try {
    const data = await adminRequest("/api/admin/documents");
    documents = data.documents || [];
    renderLibrary();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function removeDocument(doc) {
  const confirmed = window.confirm(
    `Remove "${doc.filename}" from the knowledge base? ` +
    "The chatbot will no longer answer from it."
  );

  if (!confirmed) return;

  try {
    await adminRequest(`/api/admin/documents/${doc.id}`, { method: "DELETE" });

    if (previewedDocumentId === doc.id) {
      clearPreview();
    }

    await loadDocuments();
    setStatus(`Removed ${doc.filename}.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// STEP 3: Document preview panel
function clearPreview() {
  previewedDocumentId = null;
  extractedData.textContent = "No document selected.";
  documentDataInfo.textContent = "Select a document to preview it.";
  setDataBadge("none", false);
}

function renderStructuredData(sheets) {
  extractedData.replaceChildren();

  sheets.forEach((sheet) => {
    const heading = document.createElement("h3");
    heading.textContent = `Sheet: ${sheet.sheet_name || "Data"}`;
    extractedData.appendChild(heading);

    extractedData.appendChild(createTable(sheet.columns || [], sheet.rows || []));

    if (sheet.truncated) {
      const note = document.createElement("p");
      note.textContent =
        `Showing ${sheet.rows.length} of ${sheet.total_rows} rows.`;
      extractedData.appendChild(note);
    }
  });
}

async function previewDocument(documentId) {
  previewedDocumentId = documentId;
  renderLibrary();

  extractedData.textContent = "Loading…";

  try {
    const preview = await adminRequest(`/api/admin/documents/${documentId}`);

    if (previewedDocumentId !== documentId) return;

    if (preview.structured_data.length > 0) {
      renderStructuredData(preview.structured_data);
    } else {
      extractedData.textContent = preview.text || "No text was extracted.";
    }

    documentDataInfo.textContent =
      `${preview.filename} · ${preview.character_count.toLocaleString()} characters`;
    setDataBadge(preview.file_type, true);
  } catch (error) {
    extractedData.textContent = error.message;
  }
}

// STEP 4: Add files to the knowledge base
async function uploadFiles(fileList) {
  const files = Array.from(fileList);

  if (files.length === 0 || uploading) return;

  const supported = files.filter((file) =>
    allowedExtensions.includes(file.name.split(".").pop().toLowerCase())
  );

  if (supported.length < files.length) {
    setStatus("Some files were skipped. Only PDF, XLSX, XLS and CSV are supported.", true);
  }

  uploading = true;
  dropzone.classList.add("loaded");
  browseButton.disabled = true;

  let lastDocument = null;

  for (const [index, file] of supported.entries()) {
    fileInfo.textContent =
      `Reading and indexing ${file.name} (${index + 1} of ${supported.length})… ` +
      "Large files can take a minute.";

    const formData = new FormData();
    formData.append("file", file);

    try {
      lastDocument = await adminRequest("/api/admin/documents", {
        method: "POST",
        body: formData,
      });

      setStatus(
        lastDocument.already_indexed
          ? `${file.name} is already in the knowledge base.`
          : `Added ${file.name} to the knowledge base.`
      );
    } catch (error) {
      setStatus(`${file.name}: ${error.message}`, true);

      if (error.status === 401) break;
    }
  }

  uploading = false;
  fileInput.value = "";
  browseButton.disabled = false;
  dropzone.classList.remove("loaded");
  fileInfo.textContent = "Files are read and indexed as soon as you add them.";

  if (!adminToken) return;

  await loadDocuments();

  if (lastDocument) {
    previewDocument(lastDocument.id);
  }
}

browseButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  uploadFiles(fileInput.files);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (event) => {
  uploadFiles(event.dataTransfer.files);
});

// STEP 5: Google Sheets URL validation
connectSheet.addEventListener("click", () => {
  const url = sheetUrl.value.trim();

  if (!url) {
    setStatus("Please paste your Google Sheets URL.", true);
    return;
  }

  try {
    const parsedUrl = new URL(url);

    if (
      parsedUrl.protocol !== "https:" ||
      parsedUrl.hostname !== "docs.google.com" ||
      !parsedUrl.pathname.includes("/spreadsheets/")
    ) {
      throw new Error("Invalid URL");
    }

    setStatus(
      "Google Sheets integration is not ready yet. Download the sheet as XLSX or CSV and add it instead.",
      true
    );
  } catch {
    setStatus("Please enter a valid Google Sheets URL.", true);
  }
});

// STEP 6: Start
if (adminToken) {
  showAdmin();
} else {
  showLogin();
}

checkHealth(backendPill, backendStatus);
window.setInterval(() => checkHealth(backendPill, backendStatus), 30000);
