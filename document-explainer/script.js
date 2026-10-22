const fileInput = document.getElementById("document");
const fileInfo = document.getElementById("fileInfo");
const sheetUrl = document.getElementById("sheetUrl");
const connectSheet = document.getElementById("connectSheet");
const questionForm = document.getElementById("questionForm");
const questionInput = document.getElementById("question");
const chatMessages = document.getElementById("chatMessages");
const statusText = document.getElementById("status");
const extractedData = document.getElementById("extractedData");
const documentDataInfo = document.getElementById("documentDataInfo");
const sendButton = document.getElementById("sendButton");

// New interface elements
const dropzone = document.getElementById("dropzone");
const removeFile = document.getElementById("removeFile");
const clearChat = document.getElementById("clearChat");
const chips = document.getElementById("chips");
const dataPanel = document.getElementById("dataPanel");
const dataBadge = document.getElementById("dataBadge");

const API_URL = "http://127.0.0.1:8000";

let selectedFile = null;
let selectedSheetUrl = "";
let extractedContent = "";
let uploadedFileName = "";
let extractedStructuredData = [];

const allowedExtensions = ["pdf", "xlsx", "xls", "csv"];
const WELCOME = "Hello! Upload a document, then ask me to explain it.";

// ---------- Helpers ----------
function setStatus(text, isError = false) {
  statusText.textContent = text;
  statusText.classList.toggle("error", isError);
}

function setDataBadge(text, ready) {
  dataBadge.textContent = text;
  dataBadge.classList.toggle("ready", ready);
}

function scrollChatToBottom() {
  chatMessages.scrollTo({ top: chatMessages.scrollHeight, behavior: "smooth" });
}

// STEP 1: Reset previously loaded document data
function resetDocumentData() {
  extractedContent = "";
  uploadedFileName = "";
  extractedStructuredData = [];

  extractedData.textContent = "No document data available yet.";
  documentDataInfo.textContent =
    "Select a file and ask a question to extract its data.";

  setDataBadge("empty", false);
  dropzone.classList.remove("loaded");
}

// STEP 2: Handle file selection
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  selectedFile = null;
  selectedSheetUrl = "";
  resetDocumentData();
  removeFile.hidden = true;

  if (!file) {
    fileInfo.textContent = "No file selected";
    return;
  }

  const extension = file.name.split(".").pop().toLowerCase();

  if (!allowedExtensions.includes(extension)) {
    fileInput.value = "";
    fileInfo.textContent = "Unsupported file type.";
    setStatus("Please select a PDF, XLSX, XLS or CSV file.", true);
    return;
  }

  selectedFile = file;
  sheetUrl.value = "";

  fileInfo.textContent =
    `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  dropzone.classList.add("loaded");
  removeFile.hidden = false;
  setStatus("File selected. Ask a question to process it.");
  questionInput.focus();
});

// NEW: remove the selected file
removeFile.addEventListener("click", () => {
  fileInput.value = "";
  selectedFile = null;
  resetDocumentData();
  fileInfo.textContent = "No file selected";
  removeFile.hidden = true;
  setStatus("File removed.");
});

// NEW: drag and drop
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);

["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);

dropzone.addEventListener("drop", (e) => {
  const files = e.dataTransfer.files;
  if (!files.length) return;

  fileInput.files = files;
  fileInput.dispatchEvent(new Event("change"));
});

// STEP 3: Handle Google Sheets URL
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

    selectedSheetUrl = url;
    selectedFile = null;
    fileInput.value = "";
    resetDocumentData();
    removeFile.hidden = true;

    fileInfo.textContent = "Google Sheet link selected.";
    extractedData.textContent =
      "Google Sheets integration is not connected yet.";
    documentDataInfo.textContent =
      "Google Sheets authorization is required.";

    setStatus(
      "Google Sheets integration is not ready yet. " +
      "Please upload a PDF, Excel, or CSV file.",
      true
    );
  } catch {
    setStatus("Please enter a valid Google Sheets URL.", true);
  }
});

// STEP 4: Safely display a chat message
function addMessage(role, content, isError = false) {
  const message = document.createElement("div");

  message.className = `message ${role}${isError ? " error" : ""}`;
  message.textContent = String(content ?? "");

  // Copy button on assistant answers
  if (role === "assistant" && !isError) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(content ?? ""));
        copyBtn.textContent = "Copied";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });
    // Skip the button on the welcome message
    if (content !== WELCOME) message.appendChild(copyBtn);
  }

  chatMessages.appendChild(message);
  scrollChatToBottom();

  return message;
}

// NEW: typing indicator shown while waiting for the backend
function showTyping() {
  const el = document.createElement("div");
  el.className = "message assistant typing";
  el.setAttribute("aria-label", "Assistant is typing");
  el.innerHTML = "<i></i><i></i><i></i>";
  chatMessages.appendChild(el);
  scrollChatToBottom();
  return el;
}

// STEP 5: Display matching records as an actual HTML table
function displayResultTable(tableData) {
  if (
    !tableData ||
    !Array.isArray(tableData.columns) ||
    !Array.isArray(tableData.rows)
  ) {
    return;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "result-table-wrapper";

  if (tableData.rows.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent = "No matching records found.";
    wrapper.appendChild(emptyMessage);
    chatMessages.appendChild(wrapper);
    return;
  }

  const table = document.createElement("table");
  table.className = "result-table";

  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");

  tableData.columns.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = String(column ?? "");
    headerRow.appendChild(th);
  });

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");

  tableData.rows.forEach((row) => {
    const tr = document.createElement("tr");

    tableData.columns.forEach((column, index) => {
      const td = document.createElement("td");
      let value;

      if (Array.isArray(row)) {
        value = row[index];
      } else if (row && typeof row === "object") {
        value = row[column];
      }

      td.textContent =
        value === null || value === undefined ? "" : String(value);

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrapper.appendChild(table);
  chatMessages.appendChild(wrapper);
  scrollChatToBottom();
}

// STEP 6: Upload the document to the backend
async function uploadDocument(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_URL}/api/upload`, {
    method: "POST",
    body: formData
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.detail || "Document upload failed.");
  }

  if (typeof data.extracted_content !== "string") {
    throw new Error("The backend did not return extracted document text.");
  }

  extractedStructuredData = Array.isArray(data.structured_data)
    ? data.structured_data
    : [];

  return data;
}

// NEW: suggestion chips fill the question box
chips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;

  questionInput.value = chip.dataset.q;
  questionInput.focus();
});

// NEW: Enter sends, Shift+Enter adds a new line
questionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    questionForm.requestSubmit();
  }
});

// NEW: clear the conversation
clearChat.addEventListener("click", () => {
  chatMessages.innerHTML = "";
  addMessage("assistant", WELCOME);
  setStatus("");
});

// STEP 7: Ask questions about the selected document
questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = questionInput.value.trim();

  if (!selectedFile && !selectedSheetUrl) {
    setStatus("Please select a document first.", true);
    return;
  }

  if (!question) {
    setStatus("Please enter a question.", true);
    return;
  }

  if (selectedSheetUrl && !selectedFile) {
    setStatus(
      "Google Sheets integration is not ready yet. " +
      "Please upload a PDF, Excel, or CSV file.",
      true
    );
    return;
  }

  addMessage("user", question);

  questionInput.value = "";
  sendButton.disabled = true;
  sendButton.textContent = "Working...";

  setStatus("Reading your document...");
  const typing = showTyping();

  try {
    // Upload once per selected file
    if (!extractedContent || uploadedFileName !== selectedFile.name) {
      const uploadData = await uploadDocument(selectedFile);

      extractedContent = uploadData.extracted_content;
      uploadedFileName = selectedFile.name;

      extractedData.textContent = extractedContent;

      documentDataInfo.textContent =
        `File: ${uploadData.filename} | ` +
        `Extracted characters: ${uploadData.character_count}` +
        (uploadData.truncated
          ? " | Warning: Content was truncated by the backend."
          : "");

      setDataBadge("ready", true);

      typing.before(
        Object.assign(document.createElement("div"), {
          className: "message assistant",
          textContent:
            `Document loaded: ${uploadData.filename}. ` +
            `${uploadData.character_count} characters extracted.`
        })
      );
    }

    setStatus("Finding the relevant information...");

    const response = await fetch(`${API_URL}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: question,
        document_content: extractedContent,
        structured_data: extractedStructuredData
      })
    });

    const answerData = await response.json();

    if (!response.ok) {
      throw new Error(answerData.detail || "Could not answer the question.");
    }

    typing.remove();

    if (answerData.answer) {
      addMessage("assistant", answerData.answer);
    }

    if (answerData.table) {
      displayResultTable(answerData.table);
    }

    setStatus("Answer ready.");
  } catch (error) {
    console.error("Chatbot error:", error);
    typing.remove();

    setStatus(`Error: ${error.message}`, true);
    addMessage("assistant", `Something went wrong: ${error.message}`, true);
  } finally {
    typing.remove();
    sendButton.disabled = false;
    sendButton.textContent = "Explain document";
  }
});