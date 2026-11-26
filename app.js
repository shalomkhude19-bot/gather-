"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const postList = $("#post-list");
const emptyState = $("#empty-state");
const searchInput = $("#search-input");
const modal = $("#modal-backdrop");
const imageInput = $("#image-input");
const imagePreview = $("#upload-preview");
const captionInput = $("#caption-input");
const formError = $("#form-error");
let currentUser = null;
let currentView = "home";
let nextCursor = null;
let searchTimer;
let toastTimer;
let previewUrl = null;
let currentAuthMode = "login";
let websocket = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let activeConversation = null;
let stories = [];

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body instanceof Blob ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  const contentType = response.headers.get("content-type") || "";
  const result = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status}).`);
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 2800);
}

function setAuthMode(mode) {
  currentAuthMode = mode;
  const registering = mode === "register";
  const requestingReset = mode === "forgot";
  const resetting = mode === "reset";
  $("#auth-form").dataset.mode = mode;
  $("#auth-title").textContent = registering ? "Make yourself at home."
    : requestingReset ? "Let’s get you back in."
      : resetting ? "Choose a new password."
        : "A good day to gather.";
  $("#auth-submit").textContent = registering ? "Create your account"
    : requestingReset ? "Send reset link"
      : resetting ? "Reset password"
        : "Sign in";
  $("#auth-switch-copy").textContent = registering ? "Already have an account?" : "New here?";
  $("#auth-mode-toggle").textContent = registering ? "Sign in" : "Create an account";
  $(".auth-switch").classList.toggle("hidden", requestingReset || resetting);
  $("#forgot-password").classList.toggle("hidden", mode !== "login");
  $('label[for="auth-username"]').classList.toggle("hidden", requestingReset || resetting);
  $("#auth-username").classList.toggle("hidden", requestingReset || resetting);
  $("#auth-username").required = !requestingReset && !resetting;
  $("#auth-email-field").classList.toggle("hidden", !registering && !requestingReset);
  $("#auth-email").required = registering || requestingReset;
  $("#display-name-field").classList.toggle("hidden", !registering);
  $('label[for="auth-password"]').textContent = resetting ? "New password" : "Password";
  $('label[for="auth-password"]').classList.toggle("hidden", requestingReset);
  $("#auth-password").classList.toggle("hidden", requestingReset);
  $("#auth-password").required = !requestingReset;
  $("#auth-password").autocomplete = registering || resetting ? "new-password" : "current-password";
  $("#auth-display-name").required = registering;
  $("#auth-error").textContent = "";
}

function showApp(user) {
  currentUser = user;
  $("#auth-screen").classList.add("hidden");
  $("#app-shell").classList.remove("hidden");
  $("#sidebar-name").textContent = user.displayName;
  $("#sidebar-username").textContent = `@${user.username}`;
  $("#sidebar-avatar").textContent = (user.displayName.trim()[0] || user.username[0]).toUpperCase();
  $("#admin-nav").classList.toggle("hidden", !user.isAdmin);
  $("#auth-note").textContent = "Your account, photos, and messages are stored securely.";
  renderPosts(false);
  renderSuggestions();
  renderStories();
  refreshRequestCount();
  refreshConversationCount();
  connectWebSocket();
}

function showAuth() {
  closeWebSocket();
  currentUser = null;
  $("#app-shell").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  $("#auth-username").focus();
}

function relativeTime(value) {
  const age = Math.max(0, Date.now() - new Date(value).getTime());
  if (!Number.isFinite(age)) return "just now";
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function postMarkup(post) {
  const comments = (post.comments || []).map(comment =>
    `<div class="comment-line"><strong>${escapeHtml(comment.name)}</strong>${escapeHtml(comment.text)}</div>`
  ).join("");
  return `<article class="post-card" data-post="${escapeHtml(post.id)}">
    <header class="post-header">
      <span class="avatar ${escapeHtml(post.color || "")}" aria-hidden="true">${escapeHtml(post.initial)}</span>
      <span class="post-author"><strong>${escapeHtml(post.username)}</strong><span>${escapeHtml(post.name)}</span></span>
      <button class="post-menu" type="button" aria-label="Report post by ${escapeHtml(post.username)}" data-report-type="post" data-report-id="${escapeHtml(post.id)}">···</button>
    </header>
    <div class="post-image-wrap"><img class="post-image" src="${escapeHtml(post.image)}" alt="${escapeHtml(post.alt)}" loading="lazy"></div>
    <div class="post-actions">
      <button class="action-button ${post.liked ? "liked" : ""}" type="button" data-like="${escapeHtml(post.id)}" aria-label="${post.liked ? "Unlike" : "Like"} post">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.8 8.7c0 5.1-8.8 11-8.8 11s-8.8-5.9-8.8-11A4.7 4.7 0 0 1 12 6a4.7 4.7 0 0 1 8.8 2.7Z"/></svg><span>${Number(post.likes) || 0}</span>
      </button>
      <button class="action-button" type="button" data-focus-comment="${escapeHtml(post.id)}" aria-label="Write a comment">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-9.5A7.5 7.5 0 0 1 10.5 4H12a8 8 0 0 1 8 7.5Z"/></svg><span>${Number(post.commentCount) || 0}</span>
      </button>
      <button class="action-button save-action ${post.saved ? "saved" : ""}" type="button" data-save="${escapeHtml(post.id)}" aria-label="${post.saved ? "Remove saved post" : "Save post"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4z"/></svg>
      </button>
    </div>
    <div class="post-caption"><strong>${escapeHtml(post.username)}</strong>${escapeHtml(post.caption)}
      ${comments ? `<div class="comment-list">${comments}</div>` : ""}
      <time class="post-time">${escapeHtml(relativeTime(post.time))}</time>
    </div>
    <form class="comment-form" data-comment-form="${escapeHtml(post.id)}">
      <input name="comment" maxlength="280" placeholder="Leave a kind note…" aria-label="Write a comment">
      <button type="submit">Post</button>
    </form>
    ${post.authorId === currentUser.id ? `<div class="post-owner-actions"><button type="button" data-delete="${escapeHtml(post.id)}">Delete post</button></div>` : ""}
  </article>`;
}

async function renderPosts(append = false) {
  if (!append) {
    nextCursor = null;
    postList.innerHTML = "";
    postList.classList.remove("hidden");
    emptyState.classList.add("hidden");
    $("#load-more-wrap").classList.add("hidden");
  }
  const parameters = new URLSearchParams({ view: currentView });
  const query = searchInput.value.trim();
  if (query) parameters.set("q", query);
  if (append && nextCursor) parameters.set("cursor", nextCursor);
  try {
    const result = await api(`/api/feed?${parameters.toString()}`);
    const posts = result.posts.map(postMarkup).join("");
    if (append) postList.insertAdjacentHTML("beforeend", posts);
    else postList.innerHTML = posts;
    nextCursor = result.nextCursor;
    $("#load-more-wrap").classList.toggle("hidden", !nextCursor);
    postList.classList.toggle("hidden", result.posts.length === 0 && !append);
    emptyState.classList.toggle("hidden", result.posts.length > 0 || append);
    const emptyMessages = {
      home: ["Your feed starts with people.", "Follow someone you know, or share your first moment."],
      explore: ["A little quiet for now.", "As people share photos, they’ll show up here."],
      saved: ["Nothing saved just yet.", "Tap the bookmark on a post to keep it close."],
      profile: ["Your story starts here.", "Share your first photo and make it yours."]
    };
    const [title, description] = emptyMessages[currentView];
    $("h2", emptyState).textContent = title;
    $("p", emptyState).textContent = query ? "Try a different search." : description;
  } catch (error) {
    if (!append) {
      postList.classList.add("hidden");
      emptyState.classList.remove("hidden");
      $("h2", emptyState).textContent = "We couldn’t load your posts.";
      $("p", emptyState).textContent = error.message;
    } else {
      showToast(error.message);
    }
  }
}

function setView(view) {
  currentView = view;
  document.querySelectorAll("[data-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  const headings = {
    home: ["YOUR LITTLE CORNER", "A good day to gather.", "From your people"],
    explore: ["A LITTLE INSPIRATION", "Find a new favorite.", "Explore"],
    saved: ["KEPT CLOSE", "Moments worth keeping.", "Your saved moments"],
    profile: ["YOUR SPACE", `Your moments, ${currentUser.displayName.split(" ")[0]}.`, "Shared by you"]
  };
  const [eyebrow, title, label] = headings[view];
  $("#view-eyebrow").textContent = eyebrow;
  $("#view-title").textContent = title;
  $("#feed-label").textContent = label;
  renderPosts(false);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function renderSuggestions() {
  const container = $("#suggestion-list");
  try {
    const result = await api("/api/suggestions");
    if (!result.users.length) {
      container.innerHTML = `<p class="suggestion-empty">Your people will find their way here.</p>`;
      return;
    }
    container.innerHTML = result.users.map(person => {
      const initial = (person.displayName.trim()[0] || person.username[0]).toUpperCase();
      const following = Boolean(person.following);
      const requested = Boolean(person.requested);
      return `<div class="suggestion-row">
        <span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span>
        <span class="suggestion-info"><strong>${escapeHtml(person.displayName)}</strong><span>@${escapeHtml(person.username)}</span></span>
        <button class="follow-button ${following || requested ? "following" : ""}" type="button" data-follow="${escapeHtml(person.id)}" data-private="${Boolean(person.isPrivate)}">${following ? "Following" : requested ? "Requested" : person.isPrivate ? "Request" : "Follow"}</button>
        <button class="report-user" type="button" data-report-type="user" data-report-id="${escapeHtml(person.id)}" aria-label="Report ${escapeHtml(person.username)}">···</button>
      </div>`;
    }).join("");
  } catch (error) {
    container.innerHTML = `<p class="suggestion-empty">${escapeHtml(error.message)}</p>`;
  }
}

function showFeature(title, content) {
  $("#feature-title").textContent = title;
  $("#feature-content").innerHTML = content;
  $("#feature-backdrop").classList.remove("hidden");
}

function closeFeature() {
  $("#feature-backdrop").classList.add("hidden");
  activeConversation = null;
}

async function renderStories() {
  try {
    const result = await api("/api/stories");
    stories = result.stories;
    const storyButtons = stories.map(story => `<button class="story" type="button" data-open-story="${escapeHtml(story.id)}" aria-label="View ${escapeHtml(story.displayName)}'s story">
      <span class="story-ring">${`<span class="avatar">${escapeHtml(story.initial)}</span>`}</span>
      <span>${escapeHtml(story.displayName.split(" ")[0])}</span>
    </button>`);
    $("#stories").innerHTML = [
      `<button class="story story-add" type="button" data-action="create-story" aria-label="Share your story"><span class="story-ring"><span class="avatar">+</span></span><span>Your story</span></button>`,
      ...storyButtons
    ].join("");
  } catch (error) {
    $("#stories").innerHTML = `<span class="suggestion-empty">${escapeHtml(error.message)}</span>`;
  }
}

async function openStory(storyId) {
  const story = stories.find(item => item.id === storyId);
  if (!story) {
    await renderStories();
    return openStory(storyId);
  }
  showFeature(`${escapeHtml(story.displayName)} · story`, `
    <article class="story-viewer">
      <img src="${escapeHtml(story.image)}" alt="${escapeHtml(story.alt || `Story shared by ${story.username}`)}">
      <p>${escapeHtml(story.caption)}</p>
      <time>Disappears ${escapeHtml(new Date(story.expiresAt).toLocaleString())}</time>
      <button class="report-link" type="button" data-report-type="story" data-report-id="${escapeHtml(story.id)}">Report story</button>
    </article>
  `);
}

async function refreshRequestCount() {
  try {
    const result = await api("/api/follow-requests");
    const badge = $("#request-count");
    badge.textContent = result.requests.length > 99 ? "99+" : String(result.requests.length);
    badge.classList.toggle("hidden", result.requests.length === 0);
  } catch (error) {
    console.error("Could not refresh follow request count.", error);
  }
}

async function openFollowRequests() {
  const result = await api("/api/follow-requests");
  const content = result.requests.length
    ? result.requests.map(request => `<div class="request-row">
        <span class="avatar">${escapeHtml((request.displayName[0] || request.username[0]).toUpperCase())}</span>
        <span class="suggestion-info"><strong>${escapeHtml(request.displayName)}</strong><span>@${escapeHtml(request.username)} wants to follow you</span></span>
        <button class="follow-button" type="button" data-accept-request="${escapeHtml(request.userId)}">Accept</button>
        <button class="follow-button following" type="button" data-reject-request="${escapeHtml(request.userId)}">Decline</button>
      </div>`).join("")
    : `<p class="feature-empty">No follow requests right now.</p>`;
  showFeature("Follow requests", `<div class="request-list">${content}</div>`);
}

async function openAccountSettings() {
  showFeature("Account settings", `
    <form id="settings-form" class="feature-form">
      <label class="field-label" for="settings-email">Recovery email</label>
      <input class="auth-input" id="settings-email" name="email" type="email" maxlength="254" required value="${escapeHtml(currentUser.email || "")}">
      <label class="privacy-toggle">
        <input type="checkbox" name="isPrivate" ${currentUser.isPrivate ? "checked" : ""}>
        <span><strong>Private account</strong><small>Only approved followers can see your posts and stories.</small></span>
      </label>
      <button class="create-button" type="submit">Save settings</button>
      <p class="form-error" role="alert"></p>
    </form>
  `);
}

async function openModeration() {
  if (!currentUser.isAdmin) throw new Error("Administrator access is required.");
  const result = await api("/api/admin/reports");
  const content = result.reports.length ? result.reports.map(report => `
    <article class="report-card">
      <div class="report-meta"><strong>${escapeHtml(report.targetType)} report</strong><span>${escapeHtml(report.status)}</span></div>
      <p>${escapeHtml(report.reason)}</p>
      <small>Reported by @${escapeHtml(report.reporterUsername)} · target @${escapeHtml(report.targetUsername || "unavailable")}</small>
      ${report.status === "open" ? `<div class="report-actions">
        ${report.targetType !== "user" ? `<button type="button" data-moderate="${escapeHtml(report.id)}" data-moderation-action="hide">Hide content</button>` : ""}
        ${report.targetType === "user" ? `<button type="button" data-moderate="${escapeHtml(report.id)}" data-moderation-action="suspend">Suspend account</button>` : ""}
        <button type="button" data-moderate="${escapeHtml(report.id)}" data-moderation-action="dismiss">Dismiss</button>
      </div>` : ""}
    </article>
  `).join("") : `<p class="feature-empty">No reports have been submitted.</p>`;
  showFeature("Moderation", `<div class="moderation-list">${content}</div>`);
}

async function openReportForm(targetType, targetId) {
  showFeature("Report content", `
    <form id="report-form" class="feature-form" data-report-type="${escapeHtml(targetType)}" data-report-id="${escapeHtml(targetId)}">
      <p class="feature-copy">Reports are reviewed by this app’s administrator. Please tell us what happened.</p>
      <label class="field-label" for="report-reason">Reason</label>
      <textarea id="report-reason" name="reason" maxlength="500" rows="4" required placeholder="Describe the issue…"></textarea>
      <button class="create-button" type="submit">Send report</button>
      <p class="form-error" role="alert"></p>
    </form>
  `);
}

function renderMessageThread(messages = []) {
  const active = activeConversation;
  if (!active) return;
  const list = messages.length
    ? messages.map(message => `<div class="message-bubble ${message.senderId === currentUser.id ? "mine" : ""}">
        <p>${escapeHtml(message.body)}</p><time>${escapeHtml(relativeTime(message.createdAt))}</time>
      </div>`).join("")
    : `<p class="feature-empty">Say hello and start the conversation.</p>`;
  $("#thread-content").innerHTML = `
    <header class="thread-heading"><strong>${escapeHtml(active.displayName)}</strong><small>@${escapeHtml(active.username)}</small></header>
    <div class="message-list" id="message-list">${list}</div>
    <form class="message-compose" id="message-form" data-conversation-id="${escapeHtml(active.conversationId || "")}" data-recipient-id="${escapeHtml(active.recipientId || "")}">
      <input name="body" maxlength="2000" placeholder="Write a message…" aria-label="Write a message" required>
      <button class="create-button" type="submit">Send</button>
    </form>`;
  const messageList = $("#message-list");
  if (messageList) messageList.scrollTop = messageList.scrollHeight;
}

async function loadConversationMessages(conversationId) {
  const result = await api(`/api/conversations/${conversationId}/messages`);
  if (!activeConversation || activeConversation.conversationId !== conversationId) return;
  activeConversation.messages = result.messages;
  renderMessageThread(result.messages);
  refreshConversationCount();
}

async function selectConversation(item, isNew = false) {
  activeConversation = {
    conversationId: isNew ? null : item.id,
    recipientId: isNew ? item.otherUserId : null,
    username: item.otherUsername,
    displayName: item.otherDisplayName,
    messages: []
  };
  await renderMessageDialog();
  if (activeConversation?.conversationId) {
    websocket?.readyState === WebSocket.OPEN &&
      websocket.send(JSON.stringify({ type: "subscribe", conversationId: activeConversation.conversationId }));
    await loadConversationMessages(activeConversation.conversationId);
  }
}

async function renderMessageDialog() {
  const result = await api("/api/conversations");
  const entries = [
    ...result.conversations.map(item => ({
      ...item,
      conversationId: item.id,
      subtitle: item.lastMessage || "Start a conversation",
      isNew: false
    })),
    ...result.contacts.map(item => ({ ...item, subtitle: "Start a conversation", isNew: true }))
  ];
  const rows = entries.map(item => {
    const selected = activeConversation &&
      (activeConversation.conversationId === item.conversationId ||
       (!item.conversationId && activeConversation.recipientId === item.otherUserId));
    return `<button class="conversation-row ${selected ? "selected" : ""}" type="button"
        data-open-conversation="${escapeHtml(item.conversationId || "")}"
        data-recipient="${escapeHtml(item.otherUserId)}"
        data-username="${escapeHtml(item.otherUsername)}"
        data-display-name="${escapeHtml(item.otherDisplayName)}"
        data-new="${item.isNew}">
      <span class="avatar">${escapeHtml((item.otherDisplayName[0] || item.otherUsername[0]).toUpperCase())}</span>
      <span class="suggestion-info"><strong>${escapeHtml(item.otherDisplayName)}</strong><span>${escapeHtml(item.subtitle)}</span></span>
      ${item.unreadCount ? `<span class="notification-count">${escapeHtml(item.unreadCount)}</span>` : ""}
    </button>`;
  }).join("");
  const panel = activeConversation
    ? `<section class="message-thread" id="thread-content"><p class="feature-empty">Loading conversation…</p></section>`
    : `<section class="message-thread message-empty" id="thread-content"><p class="feature-empty">Choose a conversation or start a new one.</p></section>`;
  showFeature("Messages", `<div class="messages-layout">
    <aside class="conversation-list">
      <label class="field-label" for="message-search">Find people</label>
      <input class="auth-input" id="message-search" placeholder="Search conversations">
      <div id="conversation-rows">${rows || `<p class="feature-empty">Follow someone to start a conversation.</p>`}</div>
    </aside>
    ${panel}
  </div>`);
  if (activeConversation) renderMessageThread(activeConversation.messages || []);
}

async function openMessages() {
  activeConversation = null;
  await renderMessageDialog();
}

function connectWebSocket() {
  closeWebSocket();
  if (!currentUser) return;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);
  websocket = socket;
  socket.addEventListener("open", () => { reconnectAttempts = 0; });
  socket.addEventListener("message", event => {
    let payload;
    try { payload = JSON.parse(event.data); } catch { return; }
    if (payload.type !== "message.created") return;
    if (activeConversation?.conversationId === payload.message.conversationId) {
      loadConversationMessages(payload.message.conversationId).catch(error => showToast(error.message));
    } else if (payload.message.senderId !== currentUser.id) {
      showToast("You have a new message.");
      refreshConversationCount();
    }
  });
  socket.addEventListener("close", () => {
    if (!currentUser || websocket !== socket) return;
    reconnectAttempts += 1;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connectWebSocket, Math.min(1000 * 2 ** reconnectAttempts, 15000));
  });
}

function closeWebSocket() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (websocket) {
    websocket.onclose = null;
    websocket.close();
    websocket = null;
  }
}

async function refreshConversationCount() {
  try {
    const result = await api("/api/conversations");
    const count = result.conversations.reduce((total, conversation) => total + Number(conversation.unreadCount), 0);
    const badge = $("#message-count");
    badge.textContent = count > 99 ? "99+" : String(count);
    badge.classList.toggle("hidden", count === 0);
  } catch (error) {
    console.error("Could not refresh unread message count.", error);
  }
}

function openComposer(isStory = false) {
  $("#post-form").dataset.kind = isStory ? "story" : "post";
  $("#composer-title").textContent = isStory ? "Share a story" : "Create a post";
  $(".submit-button").innerHTML = isStory
    ? 'Share for 24 hours <span aria-hidden="true">↗</span>'
    : 'Share this moment <span aria-hidden="true">↗</span>';
  captionInput.maxLength = isStory ? 200 : 500;
  $("#caption-count").textContent = `0 / ${captionInput.maxLength}`;
  modal.classList.remove("hidden");
  formError.textContent = "";
  window.setTimeout(() => captionInput.focus(), 30);
}

function clearPreview() {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  imagePreview.src = "";
  imagePreview.classList.add("hidden");
}

function closeComposer() {
  modal.classList.add("hidden");
  $("#post-form").reset();
  clearPreview();
  $("#caption-count").textContent = "0 / 500";
  $("#post-form").dataset.kind = "post";
  captionInput.maxLength = 500;
  formError.textContent = "";
}

async function handleClick(event) {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.dataset.view) {
    event.preventDefault();
    setView(target.dataset.view);
    return;
  }
  if (target.dataset.action === "create") openComposer();
  if (target.dataset.action === "create-story") openComposer(true);
  if (target.dataset.action === "close-modal") closeComposer();
  if (target.dataset.action === "close-feature") closeFeature();
  if (target.dataset.action === "messages") {
    try { await openMessages(); } catch (error) { showToast(error.message); }
  }
  if (target.dataset.action === "follow-requests") {
    try { await openFollowRequests(); } catch (error) { showToast(error.message); }
  }
  if (target.dataset.action === "settings") openAccountSettings();
  if (target.dataset.action === "moderation") {
    try { await openModeration(); } catch (error) { showToast(error.message); }
  }
  if (target.dataset.action === "logout") {
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
      showAuth();
    } catch (error) {
      showToast(error.message);
    }
  }
  if (target.dataset.openStory) {
    try { await openStory(target.dataset.openStory); } catch (error) { showToast(error.message); }
  }
  if (target.dataset.reportType && target.dataset.reportId) {
    await openReportForm(target.dataset.reportType, target.dataset.reportId);
  }
  if (target.dataset.follow) {
    target.disabled = true;
    try {
      const isFollowing = target.classList.contains("following");
      await api(`/api/users/${target.dataset.follow}/follow`, {
        method: isFollowing ? "DELETE" : "POST", body: "{}"
      });
      await renderSuggestions();
      await refreshRequestCount();
      if (currentView === "home") await renderPosts(false);
      showToast(isFollowing
        ? "You unfollowed or canceled your request."
        : target.dataset.private === "true" ? "Follow request sent." : "You’re following someone new.");
    } catch (error) {
      target.disabled = false;
      showToast(error.message);
    }
  }
  if (target.dataset.like) {
    target.disabled = true;
    try {
      const isLiked = target.classList.contains("liked");
      await api(`/api/posts/${target.dataset.like}/like`, {
        method: isLiked ? "DELETE" : "PUT", body: "{}"
      });
      await renderPosts(false);
    } catch (error) {
      target.disabled = false;
      showToast(error.message);
    }
  }
  if (target.dataset.save) {
    target.disabled = true;
    try {
      const action = target.classList.contains("saved") ? "DELETE" : "PUT";
      await api(`/api/posts/${target.dataset.save}/save`, { method: action, body: "{}" });
      await renderPosts(false);
      showToast(action === "PUT" ? "Saved for a quieter moment." : "Removed from your saved moments.");
    } catch (error) {
      target.disabled = false;
      showToast(error.message);
    }
  }
  if (target.dataset.focusComment) {
    const form = document.querySelector(`[data-comment-form="${CSS.escape(target.dataset.focusComment)}"]`);
    $("input", form)?.focus();
  }
  if (target.dataset.delete) {
    if (!window.confirm("Delete this post? This cannot be undone.")) return;
    try {
      await api(`/api/posts/${target.dataset.delete}`, { method: "DELETE" });
      await renderPosts(false);
      showToast("Your post was deleted.");
    } catch (error) {
      showToast(error.message);
    }
  }
  if (target.dataset.acceptRequest) {
    try {
      await api(`/api/follow-requests/${target.dataset.acceptRequest}/accept`, { method: "POST", body: "{}" });
      await openFollowRequests();
      await refreshRequestCount();
      showToast("Follow request accepted.");
    } catch (error) { showToast(error.message); }
  }
  if (target.dataset.rejectRequest) {
    try {
      await api(`/api/follow-requests/${target.dataset.rejectRequest}`, { method: "DELETE" });
      await openFollowRequests();
      await refreshRequestCount();
    } catch (error) { showToast(error.message); }
  }
  if (target.dataset.moderate) {
    try {
      await api(`/api/admin/reports/${target.dataset.moderate}`, {
        method: "POST", body: JSON.stringify({ action: target.dataset.moderationAction })
      });
      await openModeration();
      showToast("Moderation action recorded.");
    } catch (error) { showToast(error.message); }
  }
  if (target.dataset.openConversation !== undefined) {
    const item = {
      id: target.dataset.openConversation,
      otherUserId: target.dataset.recipient,
      otherUsername: target.dataset.username,
      otherDisplayName: target.dataset.displayName
    };
    try { await selectConversation(item, target.dataset.new === "true"); }
    catch (error) { showToast(error.message); }
  }
  if (target.id === "load-more") await renderPosts(true);
}

document.addEventListener("click", event => {
  handleClick(event).catch(error => {
    console.error("Could not complete the requested action.", error);
    showToast(error.message || "That action didn’t work. Please try again.");
  });
});

document.addEventListener("submit", async event => {
  if (event.target.id === "settings-form") {
    event.preventDefault();
    const form = event.target;
    const errorElement = $(".form-error", form);
    const data = new FormData(form);
    try {
      const result = await api("/api/me", {
        method: "PATCH",
        body: JSON.stringify({
          email: data.get("email"),
          isPrivate: data.get("isPrivate") === "on"
        })
      });
      currentUser = result.user;
      $("#sidebar-name").textContent = currentUser.displayName;
      closeFeature();
      await renderSuggestions();
      await renderStories();
      await renderPosts(false);
      showToast("Account settings saved.");
    } catch (error) { errorElement.textContent = error.message; }
    return;
  }
  if (event.target.id === "report-form") {
    event.preventDefault();
    const form = event.target;
    const errorElement = $(".form-error", form);
    const body = new FormData(form);
    try {
      await api("/api/reports", {
        method: "POST",
        body: JSON.stringify({
          targetType: form.dataset.reportType,
          targetId: form.dataset.reportId,
          reason: body.get("reason")
        })
      });
      closeFeature();
      showToast("Thanks. Your report was sent to the moderator.");
    } catch (error) { errorElement.textContent = error.message; }
    return;
  }
  if (event.target.id === "message-form") {
    event.preventDefault();
    const form = event.target;
    const input = $('input[name="body"]', form);
    const body = input.value.trim();
    if (!body || !activeConversation) return;
    try {
      let result;
      if (activeConversation.conversationId) {
        result = await api(`/api/conversations/${activeConversation.conversationId}/messages`, {
          method: "POST", body: JSON.stringify({ body })
        });
      } else {
        result = await api("/api/conversations", {
          method: "POST",
          body: JSON.stringify({ recipientId: activeConversation.recipientId, body })
        });
        activeConversation.conversationId = result.conversationId;
        websocket?.readyState === WebSocket.OPEN &&
          websocket.send(JSON.stringify({ type: "subscribe", conversationId: result.conversationId }));
      }
      input.value = "";
      await renderMessageDialog();
      if (activeConversation?.conversationId) await loadConversationMessages(activeConversation.conversationId);
      await refreshConversationCount();
    } catch (error) { showToast(error.message); }
    return;
  }
  const commentForm = event.target.closest("[data-comment-form]");
  if (commentForm) {
    event.preventDefault();
    const input = $('input[name="comment"]', commentForm);
    const body = input.value.trim();
    if (!body) return;
    try {
      await api(`/api/posts/${commentForm.dataset.commentForm}/comments`, {
        method: "POST", body: JSON.stringify({ body })
      });
      await renderPosts(false);
      showToast("Your comment has been added.");
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (event.target.id === "auth-form") {
    event.preventDefault();
    const form = event.target;
    const mode = form.dataset.mode;
    const registering = mode === "register";
    const submit = $("#auth-submit");
    const errorElement = $("#auth-error");
    const formData = new FormData(form);
    const body = {};
    if (registering) {
      body.username = formData.get("username");
      body.displayName = formData.get("displayName");
      body.email = formData.get("email");
      body.password = formData.get("password");
    } else if (mode === "login") {
      body.username = formData.get("username");
      body.password = formData.get("password");
    } else if (mode === "forgot") {
      body.email = formData.get("email");
    } else if (mode === "reset") {
      body.token = formData.get("token");
      body.password = formData.get("password");
    }
    submit.disabled = true;
    errorElement.textContent = "";
    try {
      if (mode === "forgot") {
        const result = await api("/api/auth/forgot-password", { method: "POST", body: JSON.stringify(body) });
        errorElement.textContent = result.message;
      } else if (mode === "reset") {
        const result = await api("/api/auth/reset-password", { method: "POST", body: JSON.stringify(body) });
        history.replaceState(null, "", window.location.pathname);
        form.reset();
        setAuthMode("login");
        errorElement.textContent = result.message;
      } else {
        const result = await api(registering ? "/api/auth/register" : "/api/auth/login", {
          method: "POST", body: JSON.stringify(body)
        });
        form.reset();
        setAuthMode("login");
        showApp(result.user);
      }
    } catch (error) {
      errorElement.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
    return;
  }
  if (event.target.id === "post-form") {
    event.preventDefault();
    const caption = captionInput.value.trim();
    const file = imageInput.files && imageInput.files[0];
    if (!file) {
      formError.textContent = "Choose a photo before sharing your moment.";
      return;
    }
    if (!caption) {
      formError.textContent = "Add a few words to go with your photo.";
      captionInput.focus();
      return;
    }
    const submit = $(".submit-button");
    submit.disabled = true;
    submit.textContent = "Uploading photo…";
    let mediaId = null;
    try {
      const uploaded = await api("/api/media", {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file
      });
      mediaId = uploaded.mediaId;
      const isStory = $("#post-form").dataset.kind === "story";
      await api(isStory ? "/api/stories" : "/api/posts", {
        method: "POST", body: JSON.stringify({ mediaId, caption })
      });
      searchInput.value = "";
      if (isStory) await renderStories();
      else setView("home");
      closeComposer();
      showToast(isStory ? "Your story is here for the next 24 hours." : "Your moment is here. Thanks for sharing it.");
    } catch (error) {
      formError.textContent = error.message;
      if (mediaId) {
        try {
          await api(`/api/media/${mediaId}`, { method: "DELETE" });
        } catch (cleanupError) {
          console.error("Uploaded photo cleanup failed.", cleanupError);
        }
      }
    } finally {
      submit.disabled = false;
      submit.innerHTML = 'Share this moment <span aria-hidden="true">↗</span>';
    }
  }
});

$("#auth-mode-toggle").addEventListener("click", () => {
  setAuthMode($("#auth-form").dataset.mode === "register" ? "login" : "register");
});

$("#forgot-password").addEventListener("click", () => {
  setAuthMode("forgot");
  $("#auth-email").focus();
});

document.addEventListener("input", event => {
  if (event.target.id === "message-search") {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll(".conversation-row").forEach(row => {
      row.classList.toggle("hidden", !row.textContent.toLowerCase().includes(query));
    });
  }
});

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => renderPosts(false), 220);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !modal.classList.contains("hidden")) closeComposer();
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName) && modal.classList.contains("hidden")) {
    event.preventDefault();
    searchInput.focus();
  }
});

modal.addEventListener("click", event => {
  if (event.target === modal) closeComposer();
});

$("#feature-backdrop").addEventListener("click", event => {
  if (event.target === $("#feature-backdrop")) closeFeature();
});

captionInput.addEventListener("input", () => {
  $("#caption-count").textContent = `${captionInput.value.length} / 500`;
});

imageInput.addEventListener("change", () => {
  const file = imageInput.files && imageInput.files[0];
  formError.textContent = "";
  clearPreview();
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    imageInput.value = "";
    formError.textContent = "Choose a JPEG, PNG or WebP image.";
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    imageInput.value = "";
    formError.textContent = "That image is over 10 MB. Choose a smaller file.";
    return;
  }
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
  imagePreview.classList.remove("hidden");
});

async function start() {
  setAuthMode("login");
  const resetToken = new URLSearchParams(window.location.search).get("reset");
  if (resetToken) {
    $("#reset-token").value = resetToken;
    setAuthMode("reset");
    $("#auth-password").focus();
    return;
  }
  try {
    const result = await api("/api/me");
    if (result.user) showApp(result.user);
    else showAuth();
  } catch (error) {
    showAuth();
    $("#auth-error").textContent = `Could not connect to the app server: ${error.message}`;
  }
}

start();
