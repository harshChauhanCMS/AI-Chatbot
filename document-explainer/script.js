// Public chat page: ask questions about the knowledge base.
// Documents are managed on the admin page (admin.html).

const questionForm = document.getElementById("questionForm");
const questionInput = document.getElementById("question");
const chatMessages = document.getElementById("chatMessages");
const statusText = document.getElementById("status");
const sendButton = document.getElementById("sendButton");
const clearChat = document.getElementById("clearChat");
const chips = document.getElementById("chips");
const backendPill = document.getElementById("backendPill");
const backendStatus = document.getElementById("backendStatus");

const WELCOME =
  "Hello! Ask me anything about the documents in the knowledge base.";
const HISTORY_TURNS = 3;

// Recent questions and answers, so follow-ups like "this department" work.
let history = [];

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// STEP 1: Chat messages
function addMessage(role, content, isError = false) {
  const message = document.createElement("div");

  message.className = `message ${role}${isError ? " error" : ""}`;

  const messageText = document.createElement("div");
  messageText.textContent = String(content ?? "");

  message.appendChild(messageText);
  chatMessages.appendChild(message);
  scrollChatToBottom();

  return message;
}

function addCopyButton(message, content) {
  const copyButton = document.createElement("button");

  copyButton.type = "button";
  copyButton.className = "copy-btn";
  copyButton.textContent = "Copy";

  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(content);
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

function addResultTable(message, table) {
  if (!table || !Array.isArray(table.columns) || table.columns.length === 0) {
    return;
  }

  // A single value (e.g. a total) is already stated in the answer.
  if (table.rows.length > 1 || table.columns.length > 1) {
    const wrapper = createTable(table.columns, table.rows);
    wrapper.classList.add("answer-table");
    message.appendChild(wrapper);

    if (table.truncated) {
      const note = document.createElement("p");
      note.className = "source-excerpt";
      note.textContent = `Showing the first ${table.rows.length} rows.`;
      message.appendChild(note);
    }
  }
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

// STEP 2: Suggested questions
chips.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");

  if (!chip) return;

  questionInput.value = chip.dataset.q || "";
  questionInput.focus();
});

// STEP 3: Enter sends question; Shift+Enter adds a new line
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

// STEP 4: Clear chat
clearChat.addEventListener("click", () => {
  chatMessages.replaceChildren();
  history = [];

  addMessage("assistant", WELCOME);
  setStatus("");
});

// STEP 5: Ask the knowledge base
questionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = questionInput.value.trim();

  if (!question) {
    setStatus("Please enter a question.", true);
    return;
  }

  addMessage("user", question);

  questionInput.value = "";
  sendButton.disabled = true;
  sendButton.textContent = "Working...";

  setStatus("Searching the documents...");

  const typing = showTyping();

  try {
    const answerData = await apiRequest("/api/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question: question, history: history })
    });

    typing.remove();

    const answer = answerData.answer || "The backend returned no answer.";
    const message = addMessage("assistant", answer);

    message.classList.toggle("not-found", answerData.found === false);

    if (answerData.interpreted_question) {
      const note = document.createElement("p");
      note.className = "source-excerpt";
      note.textContent = "Answered using your previous question as context.";
      message.appendChild(note);
    }

    history = [
      ...history,
      { question: question, answer: answer.slice(0, 1000) }
    ].slice(-HISTORY_TURNS);

    addResultTable(message, answerData.table);
    addCopyButton(message, answer);
    scrollChatToBottom();

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
    sendButton.disabled = false;
    sendButton.innerHTML = 'Ask <span>↗</span>';
  }
});

addMessage("assistant", WELCOME);
checkHealth(backendPill, backendStatus);
window.setInterval(() => checkHealth(backendPill, backendStatus), 30000);
