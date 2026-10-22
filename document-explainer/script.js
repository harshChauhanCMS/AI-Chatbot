
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

const API_URL = "http://127.0.0.1:8000";

let selectedFile = null;
let selectedSheetUrl = "";
let extractedContent = "";
let uploadedFileName = "";
let extractedStructuredData = [];

const allowedExtensions = ["pdf", "xlsx", "xls", "csv"];

// STEP 1: Reset previously loaded document data
function resetDocumentData() {
  extractedContent = "";
  uploadedFileName = "";
  extractedStructuredData = [];

  extractedData.textContent = "No document data available yet.";
  documentDataInfo.textContent =
    "Select a file and ask a question to extract its data.";
}

// STEP 2: Handle file selection
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  selectedFile = null;
  selectedSheetUrl = "";
  resetDocumentData();

  if (!file) {
    fileInfo.textContent = "No file selected";
    return;
  }

  const extension = file.name.split(".").pop().toLowerCase();

  if (!allowedExtensions.includes(extension)) {
    fileInput.value = "";
    fileInfo.textContent = "Unsupported file type.";
    statusText.textContent =
      "Please select PDF, XLSX, XLS, or CSV.";
    return;
  }

  selectedFile = file;
  sheetUrl.value = "";

  fileInfo.textContent =
    `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  statusText.textContent =
    "File selected. Ask a question to process it.";
});

// STEP 3: Handle Google Sheets URL
connectSheet.addEventListener("click", () => {
  const url = sheetUrl.value.trim();

  if (!url) {
    statusText.textContent =
      "Please paste your Google Sheets URL.";
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

    fileInfo.textContent = "Google Sheet link selected.";
    extractedData.textContent =
      "Google Sheets integration is not connected yet.";

    documentDataInfo.textContent =
      "Google Sheets authorization is required.";

    statusText.textContent =
      "Google Sheets integration is not ready yet. " +
      "Please upload a PDF, Excel, or CSV file.";
  } catch {
    statusText.textContent =
      "Please enter a valid Google Sheets URL.";
  }
});

// STEP 4: Safely display a chat message
function addMessage(role, content) {
  const message = document.createElement("div");

  message.className = `message ${role}`;
  message.textContent = String(content ?? "");

  chatMessages.appendChild(message);

  message.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });

  return message;
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
        value === null || value === undefined
          ? ""
          : String(value);

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrapper.appendChild(table);
  chatMessages.appendChild(wrapper);

  wrapper.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
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
    throw new Error(
      data.detail || "Document upload failed."
    );
  }

  if (typeof data.extracted_content !== "string") {
    throw new Error(
      "The backend did not return extracted document text."
    );
  }

  extractedStructuredData = Array.isArray(data.structured_data)
    ? data.structured_data
    : [];

  return data;
}

// STEP 7: Ask questions about the selected document
questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = questionInput.value.trim();

  if (!selectedFile && !selectedSheetUrl) {
    statusText.textContent = "Please select a document first.";
    return;
  }

  if (!question) {
    statusText.textContent = "Please enter a question.";
    return;
  }

  if (selectedSheetUrl && !selectedFile) {
    statusText.textContent =
      "Google Sheets integration is not ready yet. " +
      "Please upload a PDF, Excel, or CSV file.";
    return;
  }

  addMessage("user", question);

  questionInput.value = "";
  sendButton.disabled = true;

  statusText.textContent = "Reading your document...";

  try {
    // Upload once per selected file
    if (
      !extractedContent ||
      uploadedFileName !== selectedFile.name
    ) {
      const uploadData = await uploadDocument(selectedFile);

      extractedContent = uploadData.extracted_content;
      uploadedFileName = selectedFile.name;

      // Show the extracted document separately
      extractedData.textContent = extractedContent;

      documentDataInfo.textContent =
        `File: ${uploadData.filename} | ` +
        `Extracted characters: ${uploadData.character_count}` +
        (uploadData.truncated
          ? " | Warning: Content was truncated by the backend."
          : "");

      addMessage(
        "assistant",
        `Document loaded: ${uploadData.filename}. ` +
        `${uploadData.character_count} characters extracted.`
      );
    }

    // Send the question, text and structured spreadsheet data
    statusText.textContent = "Finding the relevant information...";

    const response = await fetch(`${API_URL}/api/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        question: question,
        document_content: extractedContent,
        structured_data: extractedStructuredData
      })
    });

    const answerData = await response.json();

    if (!response.ok) {
      throw new Error(
        answerData.detail || "Could not answer the question."
      );
    }

    // Display the answer returned by the backend
    if (answerData.answer) {
      addMessage("assistant", answerData.answer);
    }

    // Display actual records if the backend returns a table
    if (answerData.table) {
      displayResultTable(answerData.table);
    }

    statusText.textContent = "Answer generated successfully.";

  } catch (error) {
    console.error("Chatbot error:", error);

    statusText.textContent = `Error: ${error.message}`;

    addMessage(
      "assistant",
      `Sorry, something went wrong: ${error.message}`
    );
  } finally {
    sendButton.disabled = false;
  }
});
