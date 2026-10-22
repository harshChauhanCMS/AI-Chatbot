
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

const allowedExtensions = ["pdf", "xlsx", "xls", "csv"];

// STEP 1: Handle file selection
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];

  selectedFile = null;
  extractedContent = "";
  uploadedFileName = "";

  // Clear data from the previous document
  extractedData.textContent = "No document data available yet.";
  documentDataInfo.textContent =
    "Select a file and ask a question to extract its data.";

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
  selectedSheetUrl = "";
  sheetUrl.value = "";

  fileInfo.textContent =
    `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

  statusText.textContent =
    "File selected. Ask a question to process it.";
});

// STEP 2: Handle Google Sheets URL selection
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
    extractedContent = "";
    uploadedFileName = "";
    fileInput.value = "";

    extractedData.textContent =
      "Google Sheets integration is not connected yet.";

    documentDataInfo.textContent =
      "Google Sheets authorization is required.";

    fileInfo.textContent = "Google Sheet link selected.";

    statusText.textContent =
      "Google Sheets integration is not ready yet. " +
      "Please upload a PDF, Excel, or CSV file.";
  } catch {
    statusText.textContent =
      "Please enter a valid Google Sheets URL.";
  }
});

// STEP 3: Display messages in the chat
function addMessage(role, content) {
  const message = document.createElement("div");

  message.className = `message ${role}`;
  message.textContent = content;

  chatMessages.appendChild(message);

  message.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });
}

// STEP 4: Upload document to Python backend
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

  return data;
}

// STEP 5: Handle the user's question
questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = questionInput.value.trim();

  if (!selectedFile && !selectedSheetUrl) {
    statusText.textContent =
      "Please select a document first.";
    return;
  }

  if (!question) {
    statusText.textContent =
      "Please enter a question.";
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

  statusText.textContent =
    "Reading your document...";

  try {
    // STEP 6: Upload and extract the document
    // Reuse the extracted content for follow-up questions
    // about the same selected file.
    if (
      !extractedContent ||
      uploadedFileName !== selectedFile.name
    ) {
      const uploadData = await uploadDocument(selectedFile);

      if (typeof uploadData.extracted_content !== "string") {
        throw new Error(
          "The backend did not return extracted document text."
        );
      }

      extractedContent = uploadData.extracted_content;
      uploadedFileName = selectedFile.name;

      // Display exact extracted text separately from AI answers
      extractedData.textContent = extractedContent;

      documentDataInfo.textContent =
        `File: ${uploadData.filename} | ` +
        `Extracted characters: ${uploadData.character_count}` +
        (uploadData.truncated
          ? " | Warning: Content was truncated by the backend."
          : "");

      addMessage(
        "assistant",
        `Document read successfully: ${uploadData.filename}. ` +
        `Extracted ${uploadData.character_count} characters. ` +
        "See the Extracted Document Data section for the content."
      );
    }

    // STEP 7: Send the question and document content to Ollama
    statusText.textContent =
      "AI is thinking. Please wait...";

    const response = await fetch(`${API_URL}/api/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        question: question,
        document_content: extractedContent
      })
    });

    const answerData = await response.json();

    if (!response.ok) {
      throw new Error(
        answerData.detail ||
        "AI could not answer your question."
      );
    }

    // STEP 8: Display only the AI-generated answer in chat
    addMessage("assistant", answerData.answer);

    statusText.textContent =
      "Answer generated successfully.";

  } catch (error) {
    console.error("Chatbot error:", error);

    statusText.textContent =
      `Error: ${error.message}`;

    addMessage(
      "assistant",
      `Sorry, something went wrong: ${error.message}`
    );
  } finally {
    sendButton.disabled = false;
  }
});
