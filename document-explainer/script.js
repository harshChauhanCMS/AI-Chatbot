const fileInput = document.getElementById("document");
const browseButton = document.getElementById("browseButton");
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
const dropzone = document.getElementById("dropzone");
const removeFile = document.getElementById("removeFile");
const clearChat = document.getElementById("clearChat");
const chips = document.getElementById("chips");
const dataBadge = document.getElementById("dataBadge");

const API_URL = "http://127.0.0.1:8000";
const allowedExtensions = ["pdf", "xlsx", "xls", "csv"];
const WELCOME = "Hello! Upload a document, then ask me to explain it.";

let selectedFile = null;
let selectedSheetUrl = "";
let extractedContent = "";
let uploadedFileName = "";
let extractedStructuredData = [];

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function setDataBadge(message, ready) {
  dataBadge.textContent = message;
  dataBadge.classList.toggle("ready", ready);
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

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

function addMessage(role, content, isError = false) {
  const message = document.createElement("div");

  message.className =
    `message ${role}${isError ? " error" : ""}`;

  const messageText = document.createElement("div");
  messageText.textContent = String(content ?? "");

  message.appendChild(messageText);

  if (role === "assistant" && !isError && content !== WELCOME) {
    const copyButton = document.createElement("button");

    copyButton.type = "button";
    copyButton.className = "copy-btn";
    copyButton.textContent = "Copy";

    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(String(content ?? ""));
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Copy failed";
      }

      window.setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 1500);
    });

    message.appendChild(copyButton);
  }

  chatMessages.appendChild(message);
  scrollChatToBottom();

  return message;
}

function showTyping() {
  const indicator = document.createElement("div");

  indicator.className = "message assistant typing";
  indicator.setAttribute("aria-label", "Assistant is typing");

  for (let i = 0; i < 3; i += 1) {
    indicator.appendChild(document.createElement("i"));
  }

  chatMessages.appendChild(indicator);
  scrollChatToBottom();

  return indicator;
}

// STEP 1: Display matching records as an HTML table
function displayResultTable(tableData) {
  console.log("Received table data:", tableData);

  if (
    !tableData ||
    !Array.isArray(tableData.columns) ||
    !Array.isArray(tableData.rows)
  ) {
    console.error("Invalid table data:", tableData);

    addMessage(
      "assistant",
      "The answer was received, but table data was not returned correctly."
    );

    return;
  }



  const wrapper = document.createElement("div");
  wrapper.className = "message assistant result-table-wrapper";

  const heading = document.createElement("h4");
  heading.textContent = "Matching Records";

  wrapper.appendChild(heading);

  if (tableData.rows.length === 0) {
    const emptyMessage = document.createElement("p");

    emptyMessage.textContent = "No matching records found.";

    wrapper.appendChild(emptyMessage);
    chatMessages.appendChild(wrapper);

    scrollChatToBottom();
    return;
  }

  const scrollContainer = document.createElement("div");
  scrollContainer.className = "table-scroll";

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

      let value = "";

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
  scrollContainer.appendChild(table);
  wrapper.appendChild(scrollContainer);

  chatMessages.appendChild(wrapper);
  scrollChatToBottom();
}

// STEP 2: Upload a document to FastAPI

 // STEP 2: Upload a document to FastAPI
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
    throw new Error(
      "The backend did not return extracted document text."
    );
  }

  // Save the extracted text for the AI chatbot.
  extractedContent = data.extracted_content;
  uploadedFileName = data.filename || file.name;

  // Save structured Excel/CSV data.
  extractedStructuredData = Array.isArray(data.structured_data)
    ? data.structured_data
    : [];

  // Show the original document data before asking the AI.
  if (extractedStructuredData.length > 0) {
    renderStructuredData(
      extractedStructuredData,
      extractedContent
    );
  } else if (extractedContent) {
    extractedData.textContent = extractedContent;
  }

  // Update the document information.
  if (documentDataInfo) {
    documentDataInfo.textContent =
      `${uploadedFileName} — ${data.character_count || 0} characters`;
  }

  return data;
}


function renderStructuredData(sheets, fallbackText = "") {
  extractedData.replaceChildren();

  // If there is no spreadsheet data, show extracted text.
  if (!Array.isArray(sheets) || sheets.length === 0) {
    extractedData.textContent =
      fallbackText || "No document data available.";
    return;
  }

  sheets.forEach((sheet) => {
    const heading = document.createElement("h3");
    heading.textContent = `Sheet: ${sheet.sheet_name || "Data"}`;
    extractedData.appendChild(heading);

    const columns = sheet.columns || [];
    const rows = sheet.rows || [];

    if (columns.length === 0) {
      const message = document.createElement("p");
      message.textContent = "No columns found in this sheet.";
      extractedData.appendChild(message);
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "table-scroll";

    const table = document.createElement("table");
    table.className = "result-table";

    // Create table headings.
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = String(column);
      headerRow.appendChild(th);
    });

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Create table rows.
    const tbody = document.createElement("tbody");

    rows.forEach((row) => {
      const tr = document.createElement("tr");

      columns.forEach((column) => {
        const td = document.createElement("td");
        td.textContent = String(row[column] ?? "");
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);
    extractedData.appendChild(wrapper);

    if (sheet.truncated) {
      const note = document.createElement("p");
      note.textContent = "Showing the first 5,000 rows.";
      extractedData.appendChild(note);
    }
  });
}



// STEP 3: Validate the selected file
function validateAndSelectFile(file) {
  if (!file) return;

  const extension = file.name.split(".").pop().toLowerCase();

  if (!allowedExtensions.includes(extension)) {
    fileInput.value = "";
    selectedFile = null;

    fileInfo.textContent = "Unsupported file type.";

    setStatus(
      "Please select a PDF, XLSX, XLS or CSV file.",
      true
    );

    return;
  }

  selectedFile = file;
  selectedSheetUrl = "";
  sheetUrl.value = "";

  resetDocumentData();

  fileInfo.textContent =
    `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  dropzone.classList.add("loaded");
  removeFile.hidden = false;

  setStatus("File selected. Ask a question to process it.");
}

// STEP 4: Browse files
browseButton.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  if (!file) {
    selectedFile = null;
    fileInfo.textContent = "No file selected";
    return;
  }

  validateAndSelectFile(file);
});

// STEP 5: Remove selected file
removeFile.addEventListener("click", () => {
  fileInput.value = "";
  selectedFile = null;
  selectedSheetUrl = "";

  resetDocumentData();

  fileInfo.textContent = "No file selected";
  removeFile.hidden = true;

  setStatus("File removed.");
});

// STEP 6: Drag and drop
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
  const file = event.dataTransfer.files[0];

  if (!file) return;

  validateAndSelectFile(file);

  try {
    const transfer = new DataTransfer();

    transfer.items.add(file);
    fileInput.files = transfer.files;
  } catch {
    // selectedFile is used directly if assignment is blocked.
  }
});

// STEP 7: Google Sheets URL validation
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
      "Google Sheets integration is not ready yet. Please upload a PDF, Excel or CSV file.",
      true
    );
  } catch {
    setStatus("Please enter a valid Google Sheets URL.", true);
  }
});

// STEP 8: Suggested questions
chips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");

  if (!chip) return;

  questionInput.value = chip.dataset.q || "";
  questionInput.focus();
});

// STEP 9: Enter sends question; Shift+Enter adds a new line
questionInput.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  ) {
    event.preventDefault();
    questionForm.requestSubmit();
  }
});

// STEP 10: Clear chat
clearChat.addEventListener("click", () => {
  chatMessages.replaceChildren();

  addMessage("assistant", WELCOME);
  setStatus("");
});

// STEP 11: Ask the AI about the document
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
      "Google Sheets integration is not ready yet. Please upload a PDF, Excel or CSV file.",
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
    // Upload the document only when needed.
    if (
      !extractedContent ||
      uploadedFileName !== selectedFile.name
    ) {
      const uploadData = await uploadDocument(selectedFile);

      extractedContent = uploadData.extracted_content;
      uploadedFileName = selectedFile.name;

      // Show extracted source text separately from AI answers.
      extractedData.textContent =
        extractedContent || "No text was extracted from this file.";

      documentDataInfo.textContent =
        `File: ${uploadData.filename || selectedFile.name} | ` +
        `Extracted characters: ${
          uploadData.character_count ?? extractedContent.length
        }` +
        (
          uploadData.truncated
            ? " | Warning: content was truncated by the backend."
            : ""
        );

      setDataBadge("ready", true);
    }

    setStatus("Finding the relevant information...");

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

    console.log("Complete API response:", answerData);
    console.log("Table data:", answerData.table);

    if (!response.ok) {
      throw new Error(
        answerData.detail || "Could not answer the question."
      );
    }

    typing.remove();

    // Display the AI's text answer.
    if (answerData.answer) {
      addMessage("assistant", answerData.answer);
    } else {
      addMessage(
        "assistant",
        "The backend returned no text answer."
      );
    }

    // Display a table if the backend returned one.
    if (answerData.table) {
      displayResultTable(answerData.table);
    }

    setStatus("Answer ready.");
  } catch (error) {
    console.error("Chatbot error:", error);

    typing.remove();

    setStatus(`Error: ${error.message}`, true);

    addMessage(
      "assistant",
      `Something went wrong: ${error.message}`,
      true
    );
  } finally {
    typing.remove();

    sendButton.disabled = false;
    sendButton.innerHTML =
      'Explain document <span>↗</span>';
  }
});