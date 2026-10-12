let currentThreadId = localStorage.getItem("pathora_thread_id") || null;
let latestAnswerMarkdown = "";
let waitingForApproval = false;
let executionStartedAt = 0;
let executionTimer = null;

const AGENT_DETAILS = {
  flight_agent: { label: "Flight specialist", tool: "AviationStack airport & airline data" },
  hotel_agent: { label: "Stay specialist", tool: "Tavily hotel web research" },
  weather_agent: { label: "Weather specialist", tool: "Weather and forecast MCP services" },
  budget_agent: { label: "Budget specialist", tool: "Budget analysis" },
  itinerary_agent: { label: "Itinerary specialist", tool: "Travel-plan synthesis" },
  final_agent: { label: "Final response agent", tool: "Groq LLM finalization" }
};

const $ = (selector) => document.querySelector(selector);

function setPrompt(text) {
  const input = $("#userInput");
  input.value = text;
  updateCharacterCount();
  input.focus();
}

function updateCharacterCount() {
  const input = $("#userInput");
  const counter = $("#charCount");
  if (input && counter) counter.textContent = `${input.value.length} / ${input.maxLength}`;
}

function setLoading(isLoading, mode = "draft") {
  $("#sendBtn").disabled = isLoading;
  $("#approveBtn").disabled = isLoading || !waitingForApproval;
  $("#reviseBtn").disabled = isLoading || !waitingForApproval;
  $("#btnText").classList.toggle("hidden", isLoading && mode === "draft");
  $("#btnLoader").classList.toggle("hidden", !isLoading || mode !== "draft");
}

function showError(message) {
  const box = $("#errorBox");
  box.textContent = message || "Something went wrong. Please try again.";
  box.classList.remove("hidden");
  box.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideError() {
  const box = $("#errorBox");
  box.textContent = "";
  box.classList.add("hidden");
}

function renderMarkdown(element, markdown) {
  if (typeof marked !== "undefined") element.innerHTML = marked.parse(markdown || "");
  else element.textContent = markdown || "";

  // Some model responses end with a bare Markdown bullet, which renders as an
  // empty list item and leaves an untidy dot beneath an otherwise complete plan.
  while (element.lastElementChild) {
    const block = element.lastElementChild;
    const isEmptyParagraph = block.tagName === "P" && !block.textContent.trim();
    const isEmptyList = ["UL", "OL"].includes(block.tagName)
      && [...block.children].every((item) => !item.textContent.trim());
    if (!isEmptyParagraph && !isEmptyList) break;
    block.remove();
  }
}

function showWorkflowLoading() {
  const badge = $("#guardrailBadge");
  const chips = $("#agentChips");
  const status = $("#toolExecutionStatus");

  executionStartedAt = Date.now();
  clearInterval(executionTimer);
  badge.textContent = "Supervisor routing";
  badge.classList.remove("blocked");
  $("#supervisorReasoning").textContent = "The guardrail is reviewing your request. The supervisor will select only the agents and MCP tools needed for this trip.";
  chips.innerHTML = "<span class=\"agent-chip agent-chip-loading\">Guardrail + supervisor — selecting agents and tools…</span>";
  const updateStatus = () => {
    const seconds = Math.floor((Date.now() - executionStartedAt) / 1000);
    status.textContent = `Planning in progress · ${seconds}s elapsed`;
  };
  updateStatus();
  executionTimer = setInterval(updateStatus, 1000);
}

function showWorkflow(data) {
  const section = $("#workflowSection");
  const badge = $("#guardrailBadge");
  const chips = $("#agentChips");
  const status = $("#toolExecutionStatus");
  const allowed = data.guardrail_allowed !== false;
  clearInterval(executionTimer);
  executionTimer = null;
  $("#supervisorReasoning").textContent = data.supervisor_reasoning || (allowed ? "The supervisor has selected a travel workflow for your request." : "This request could not enter the travel workflow.");
  badge.textContent = allowed ? "Guardrail passed" : "Guardrail blocked";
  badge.classList.toggle("blocked", !allowed);
  chips.replaceChildren();
  (data.selected_agents || []).forEach((agent) => {
    const detail = AGENT_DETAILS[agent] || { label: agent, tool: "PATHORA workflow" };
    const chip = document.createElement("span");
    chip.className = "agent-chip";
    chip.title = `Tool: ${detail.tool}`;
    chip.textContent = `${detail.label} · ${detail.tool}`;
    chips.appendChild(chip);
  });
  if (data.approved === true) {
    const detail = AGENT_DETAILS.final_agent;
    const chip = document.createElement("span");
    chip.className = "agent-chip";
    chip.title = `Tool: ${detail.tool}`;
    chip.textContent = `${detail.label} — ${detail.tool}`;
    chips.appendChild(chip);
  }
  if (!chips.childElementCount) {
    const chip = document.createElement("span");
    chip.className = "agent-chip";
    chip.textContent = allowed ? "Itinerary specialist · Travel-plan synthesis" : "No specialist tools were run";
    chips.appendChild(chip);
  }
  const count = (data.selected_agents || []).length + (data.approved === true ? 1 : 0);
  status.textContent = allowed
    ? `${count || 1} agent${count === 1 ? "" : "s"} selected and run for this request.`
    : "No MCP tools were run because the guardrail blocked this request.";
  section.classList.remove("hidden");
}

function showResult(answer, threadId, isDraft = false) {
  latestAnswerMarkdown = answer || "";
  renderMarkdown($("#resultBox"), latestAnswerMarkdown);
  $("#threadInfo").textContent = `PATHORA journey · ${threadId || "—"}`;
  $("#resultTitle").textContent = isDraft ? "Your draft route, ready for review." : "A journey worth looking forward to.";
  const section = $("#resultSection");
  section.classList.remove("hidden");
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showApproval(data) {
  waitingForApproval = true;
  $("#approvalRequest").textContent = data.approval_request || "Approve the draft or tell PATHORA what to change before the final plan is created.";
  $("#approval-title").textContent = data.human_feedback ? "Review the revised draft itinerary." : "Review the draft itinerary.";
  $("#approvalSection").classList.remove("hidden", "approval-preview");
  $("#approvalFeedback").value = "";
  $("#approvalFeedback").disabled = false;
  $("#approveBtn").disabled = false;
  $("#reviseBtn").disabled = false;
}

function hideApproval() {
  waitingForApproval = false;
  $("#approvalSection").classList.add("hidden");
  $("#approvalFeedback").value = "";
  $("#approvalFeedback").disabled = true;
  $("#approveBtn").disabled = true;
  $("#reviseBtn").disabled = true;
}

async function readResponse(response) {
  try { return await response.json(); }
  catch { throw new Error("PATHORA returned an unexpected response. Please try again."); }
}

async function sendMessage() {
  hideError();
  if (waitingForApproval) return showError("Please approve or revise the current draft before starting another plan.");
  const message = $("#userInput").value.trim();
  if (!message) { showError("Tell PATHORA a little about the journey you have in mind."); $("#userInput").focus(); return; }
  setLoading(true);
  showWorkflowLoading();
  try {
    const response = await fetch("/api/travel", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ message, thread_id:currentThreadId }) });
    const data = await readResponse(response);
    if (!response.ok || !data.success) throw new Error(data.error || "PATHORA could not build the route right now.");
    currentThreadId = data.thread_id;
    localStorage.setItem("pathora_thread_id", currentThreadId);
    showWorkflow(data);
    if (data.requires_approval) { showResult(data.itinerary || data.answer, data.thread_id, true); showApproval(data); }
    else { hideApproval(); showResult(data.answer, data.thread_id); }
  } catch (error) { clearInterval(executionTimer); executionTimer = null; showError(error.message); }
  finally { setLoading(false); }
}

async function submitApproval(approved) {
  hideError();
  if (!currentThreadId || !waitingForApproval) return showError("There is no draft waiting for approval.");
  const feedback = $("#approvalFeedback").value.trim();
  if (!approved && !feedback) { showError("Add revision feedback before requesting changes."); $("#approvalFeedback").focus(); return; }
  setLoading(true, "approval");
  try {
    const response = await fetch("/api/travel/approve", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ thread_id:currentThreadId, approved, feedback }) });
    const data = await readResponse(response);
    if (!response.ok || !data.success) throw new Error(data.error || "PATHORA could not resume the travel workflow.");
    showWorkflow(data);
    if (data.requires_approval) {
      showResult(data.itinerary || data.answer, data.thread_id, true);
      showApproval(data);
    } else {
      hideApproval();
      showResult(data.answer, data.thread_id);
    }
  } catch (error) { showError(error.message); }
  finally { setLoading(false, "approval"); }
}

async function copyResult() {
  const text = $("#resultBox").innerText.trim();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); const button = $(".copy-btn"); const original = button.textContent; button.textContent = "Copied"; setTimeout(() => { button.textContent = original; }, 1400); }
  catch { showError("Could not copy the journey plan."); }
}

function downloadPDF() {
  if (!latestAnswerMarkdown) return showError("Build a journey plan before saving it as a PDF.");
  if (typeof html2pdf === "undefined") return showError("PDF export is still loading. Please try again in a moment.");
  const button = $(".download-btn"); const original = button.innerHTML;
  button.textContent = "Preparing…"; button.disabled = true;
  html2pdf().set({ margin:.5, filename:"pathora-journey-plan.pdf", image:{type:"jpeg",quality:.97}, html2canvas:{scale:2,useCORS:true,backgroundColor:"#fffdf8"}, jsPDF:{unit:"in",format:"a4",orientation:"portrait"}, pagebreak:{mode:["avoid-all","css","legacy"]} }).from($("#pdfContent")).save()
    .catch(() => showError("PATHORA could not create the PDF. Please try again."))
    .finally(() => { button.innerHTML = original; button.disabled = false; });
}

document.addEventListener("DOMContentLoaded", () => {
  const input = $("#userInput");
  input.addEventListener("input", updateCharacterCount);
  input.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); sendMessage(); } });
  updateCharacterCount();
});
