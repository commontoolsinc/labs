<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Morphing FAB - Specification</title>
  <style>
    /* ==========================================================================
       MORPHING FAB SPECIFICATION
       ==========================================================================

       A floating action button that morphs into an interactive composer with
       notification peek and full history view.

       STATE MACHINE:
       1. Collapsed (56x56 circle) - Initial state
       2. Expanded (400x160) - Composer visible
       3. Expanded + Peek (400x240) - Composer + latest notification preview
       4. Expanded + History (400x400) - Full history with context pills

       TRANSITIONS:
       - Click FAB → Expand to composer
       - Click backdrop/ESC → Collapse
       - Click peek area → Toggle history
       - Click history tab → Toggle history
       - New notification → Show peek (if not dismissed)
       - Dismiss peek → Hide peek but keep in history

       ========================================================================== */

    /* Base Reset
       ========================================================================== */
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
      overflow: hidden;
    }

    /* Backdrop Overlay
       ==========================================================================
       Dims the background when FAB is expanded. Clicking dismisses the FAB. */
    .backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0);
      pointer-events: none;
      transition: background 0.3s ease;
      z-index: 998;
    }

    .backdrop.active {
      background: rgba(0, 0, 0, 0.3);
      pointer-events: auto;
    }

    /* FAB Container
       ==========================================================================
       Fixed positioning in bottom-right corner. */
    .fab-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999;
    }

    /* FAB Element - Main Morphing Container
       ==========================================================================
       Transitions: circle → rounded rectangle
       Uses flexbox column layout to stack: peek, history, composer
       Spring easing: cubic-bezier(0.34, 1.56, 0.64, 1) for bouncy feel */
    .fab {
      position: relative;
      width: 56px;
      height: 56px;
      background: #000;
      border-radius: 50%;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      transition:
        width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
        height 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
        border-radius 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
        background 0.3s ease;
    }

    /* State: Expanded (no notification) */
    .fab.expanded {
      width: 400px;
      height: 160px;
      border-radius: 12px;
      cursor: default;
      background: #fafafa;
    }

    /* State: Expanded + has notification peek */
    .fab.expanded.has-notification {
      height: 240px;
    }

    /* State: Expanded + history visible */
    .fab.expanded.with-history {
      height: 400px;
    }

    /* FAB Icon (Message Icon)
       ==========================================================================
       Visible only when collapsed. Fades out and rotates during expansion. */
    .fab-icon {
      position: absolute;
      width: 24px;
      height: 24px;
      transition: opacity 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: none;
      z-index: 1;
    }

    .fab-icon svg {
      width: 100%;
      height: 100%;
      fill: white;
    }

    .fab.expanded .fab-icon {
      opacity: 0;
      transform: scale(0.5) rotate(90deg);
    }

    /* History Tab Handle
       ==========================================================================
       Small tab at the top edge for pulling down history.
       Alternative to clicking the peek area. */
    .history-tab {
      position: absolute;
      top: 0;
      left: 50%;
      transform: translateX(-50%) translateY(-50%);
      width: 48px;
      height: 16px;
      background: #888;
      border-radius: 8px;
      cursor: pointer;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s ease 0.2s, background 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
    }

    .history-tab::after {
      content: '';
      width: 20px;
      height: 2px;
      background: rgba(255, 255, 255, 0.5);
      border-radius: 1px;
    }

    .fab.expanded .history-tab {
      opacity: 0.6;
      pointer-events: auto;
    }

    .history-tab:hover {
      opacity: 1;
      background: #666;
    }

    /* Notification Peek Area
       ==========================================================================
       Shows latest notification with rich actions when expanded.
       Height animates from 0 → 80px when notification is present and not dismissed.
       Clicking peek area toggles full history view. */
    .notification-peek {
      width: 100%;
      height: 0;
      background: white;
      border-bottom: 1px solid #e5e5e5;
      overflow: hidden;
      cursor: pointer;
      transition:
        height 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
        opacity 0.3s ease;
      opacity: 0;
    }

    /* Hide when empty (no notifications or dismissed) */
    .notification-peek.empty {
      display: none;
    }

    .notification-peek:hover {
      background: #fafafa;
    }

    .notification-peek:hover .notification-peek-inner::after {
      background: #999;
    }

    /* Show peek when expanded and not dismissed */
    .fab.expanded .notification-peek:not(.empty) {
      opacity: 1;
    }

    .fab.expanded:not(.with-history) .notification-peek:not(.empty) {
      height: 80px;
    }

    /* Hide peek when full history is visible */
    .fab.expanded.with-history .notification-peek {
      height: 0;
    }

    /* Notification Peek - Inner Container */
    .notification-peek-inner {
      padding: 12px 16px;
      padding-right: 40px; /* Space for dismiss button */
      height: 80px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      position: relative;
    }

    /* Visual indicator that peek is clickable/expandable */
    .notification-peek-inner::after {
      content: '';
      position: absolute;
      bottom: 4px;
      left: 50%;
      transform: translateX(-50%);
      width: 24px;
      height: 3px;
      background: #ddd;
      border-radius: 2px;
    }

    /* Dismiss Button (X) - Hides peek without removing from history */
    .notification-peek-dismiss {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 24px;
      height: 24px;
      border: none;
      background: none;
      color: #999;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: all 0.2s;
      font-size: 16px;
      line-height: 1;
    }

    .notification-peek-dismiss:hover {
      background: #f0f0f0;
      color: #333;
    }

    /* Notification Text - Max 2 lines with ellipsis */
    .notification-peek-text {
      font-size: 13px;
      color: #333;
      line-height: 1.4;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    /* Notification Actions - Interactive buttons in peek */
    .notification-peek-actions {
      display: flex;
      gap: 6px;
    }

    .notification-peek-actions button {
      padding: 4px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      background: white;
      color: #333;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    .notification-peek-actions button:hover {
      background: #f5f5f5;
      border-color: #999;
    }

    /* History Panel
       ==========================================================================
       Contains context pills bar and chat-style message history.
       Expands from height 0 → 240px when toggled. */
    .history-panel {
      width: 100%;
      height: 0;
      background: #fafafa;
      border-bottom: 1px solid #e5e5e5;
      overflow: hidden;
      opacity: 0;
      transition:
        height 0.4s cubic-bezier(0.34, 1.56, 0.64, 1),
        opacity 0.3s ease;
    }

    .fab.expanded .history-panel {
      opacity: 1;
    }

    .fab.expanded.with-history .history-panel {
      height: 240px;
    }

    /* History Panel - Inner Container with scrolling */
    .history-panel-inner {
      padding: 12px;
      height: 240px;
      overflow-y: auto;
      scroll-behavior: smooth;
      display: flex;
      flex-direction: column;
    }

    /* Custom scrollbar styling */
    .history-panel-inner::-webkit-scrollbar {
      width: 6px;
    }

    .history-panel-inner::-webkit-scrollbar-track {
      background: transparent;
    }

    .history-panel-inner::-webkit-scrollbar-thumb {
      background: #ddd;
      border-radius: 3px;
    }

    .history-panel-inner::-webkit-scrollbar-thumb:hover {
      background: #ccc;
    }

    /* History Header - Title and Clear Button */
    .history-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      flex-shrink: 0;
    }

    .history-panel h3 {
      color: #bbb;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 600;
      margin: 0;
    }

    .history-clear {
      padding: 3px 8px;
      background: none;
      border: 1px solid #ddd;
      border-radius: 4px;
      color: #999;
      font-size: 10px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .history-clear:hover {
      background: #f5f5f5;
      border-color: #999;
      color: #666;
    }

    /* Context Pills - Horizontal scrolling bar of tools/sources/attachments
       ==========================================================================
       Shows what tools, sources, and attachments are available/used.
       Pills have staggered fade-in animation for polish. */
    .context-pills {
      display: flex;
      gap: 6px;
      margin-bottom: 12px;
      overflow-x: auto;
      padding-bottom: 6px;
      flex-shrink: 0;
      scrollbar-width: thin;
    }

    .context-pills:empty {
      display: none;
    }

    .context-pills::-webkit-scrollbar {
      height: 4px;
    }

    .context-pills::-webkit-scrollbar-track {
      background: transparent;
    }

    .context-pills::-webkit-scrollbar-thumb {
      background: #e5e5e5;
      border-radius: 2px;
    }

    .context-pills::-webkit-scrollbar-thumb:hover {
      background: #ddd;
    }

    /* Individual Context Pill */
    .context-pill {
      padding: 5px 12px;
      background: white;
      border: 1px solid #e5e5e5;
      border-radius: 16px;
      color: #666;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
      display: flex;
      align-items: center;
      gap: 5px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
      animation: pillFadeIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes pillFadeIn {
      from {
        opacity: 0;
        transform: scale(0.9) translateY(-5px);
      }
      to {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
    }

    .context-pill:hover {
      background: #fafafa;
      border-color: #999;
      color: #333;
      transform: translateY(-1px);
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.08);
    }

    .context-pill:active {
      transform: translateY(0);
    }

    .context-pill-icon {
      font-size: 11px;
      opacity: 0.7;
    }

    /* History Messages - Chat-style message bubbles
       ========================================================================== */
    .history-messages {
      flex: 1;
      overflow-y: auto;
      margin: -12px;
      padding: 12px;
    }

    /* Show divider only when context pills are present */
    .context-pills:not(:empty) ~ .history-messages {
      padding-top: 8px;
      border-top: 1px solid #f0f0f0;
      margin-top: 0;
    }

    .history-messages::-webkit-scrollbar {
      width: 6px;
    }

    .history-messages::-webkit-scrollbar-track {
      background: transparent;
    }

    .history-messages::-webkit-scrollbar-thumb {
      background: #ddd;
      border-radius: 3px;
    }

    /* History Items Container */
    .history-items {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Individual History Item - Chat Bubble
       ==========================================================================
       User messages: Right-aligned, black background
       System/notifications: Left-aligned, white background with border */
    .history-item {
      max-width: 75%;
      padding: 8px 12px;
      color: #333;
      font-size: 13px;
      line-height: 1.4;
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
    }

    /* User message styling - right-aligned, dark */
    .history-item.user-message {
      align-self: flex-end;
      background: #000;
      color: white;
      border-bottom-right-radius: 4px;
    }

    /* System/notification styling - left-aligned, light */
    .history-item.notification-message {
      align-self: flex-start;
      background: white;
      color: #333;
      border-bottom-left-radius: 4px;
      border: 1px solid #e5e5e5;
    }

    /* Action Buttons in History Items */
    .history-item-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .history-item-actions button {
      padding: 4px 10px;
      border: 1px solid rgba(0, 0, 0, 0.15);
      border-radius: 4px;
      background: white;
      color: #333;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
    }

    /* Button styling for user messages (on dark background) */
    .history-item.user-message .history-item-actions button {
      background: rgba(255, 255, 255, 0.2);
      border-color: rgba(255, 255, 255, 0.3);
      color: white;
    }

    .history-item-actions button:hover {
      background: #f5f5f5;
      border-color: #999;
      transform: translateY(-1px);
    }

    .history-item.user-message .history-item-actions button:hover {
      background: rgba(255, 255, 255, 0.3);
      border-color: rgba(255, 255, 255, 0.5);
    }

    /* Composer Section
       ==========================================================================
       Contains textarea and send button. Always at bottom of FAB.
       Fills available space using flexbox. */
    .composer-section {
      position: relative;
      width: 100%;
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 16px;
      opacity: 0;
      transform: scale(0.95);
      transition:
        opacity 0.3s ease,
        transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      pointer-events: none;
    }

    .fab.expanded .composer-section {
      opacity: 1;
      transform: scale(1);
      pointer-events: auto;
      transition-delay: 0.1s;
    }

    .composer {
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: 100%;
    }

    /* Textarea - Multiline input with auto-grow */
    .composer textarea {
      width: 100%;
      flex: 1;
      min-height: 60px;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: white;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      resize: none;
      transition: border-color 0.2s;
    }

    .composer textarea:focus {
      border-color: #000;
    }

    /* Send Button */
    .composer button {
      width: 100%;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 6px;
      background: white;
      color: #333;
      font-weight: 500;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      flex-shrink: 0;
    }

    .composer button:hover {
      background: #fafafa;
      border-color: #000;
    }

    /* Toast Notification
       ==========================================================================
       Pops up above composer to show feedback for actions.
       Auto-dismisses after 3 seconds. */
    .toast {
      position: absolute;
      top: -64px;
      left: 0;
      right: 0;
      background: white;
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      border: 1px solid #e5e5e5;
      transform: translateY(20px);
      opacity: 0;
      pointer-events: none;
      transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
      color: #333;
      font-size: 13px;
      z-index: 20;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    /* Notification Bubble (when FAB is closed)
       ==========================================================================
       Floating bubble above closed FAB. Clicking expands the FAB. */
    .notification-bubble {
      position: absolute;
      bottom: 70px;
      right: 0;
      background: white;
      border-radius: 8px;
      padding: 10px 14px;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      border: 1px solid #e5e5e5;
      color: #333;
      font-size: 12px;
      max-width: 200px;
      cursor: pointer;
      transform: scale(0) translateY(20px);
      opacity: 0;
      transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.3s ease;
    }

    .notification-bubble.show {
      transform: scale(1) translateY(0);
      opacity: 1;
    }

    /* Simulate Button (for demo purposes)
       ========================================================================== */
    .simulate-btn {
      position: fixed;
      top: 20px;
      left: 20px;
      padding: 10px 20px;
      background: #000;
      border: none;
      border-radius: 6px;
      color: white;
      font-weight: 500;
      font-size: 12px;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s;
    }

    .simulate-btn:hover {
      transform: translateY(-2px);
    }

</style>
</head>
<body>
  <!-- Demo: Simulate notification button -->
  <button class="simulate-btn" onclick="simulateNotification()">Simulate Notification</button>

<!-- Backdrop overlay -->
<div class="backdrop"></div>

<!-- FAB Container -->
<div class="fab-container">
    <!-- Notification bubble (when FAB is collapsed) -->
    <div class="notification-bubble">
      <div class="notification-content"></div>
    </div>

    <!-- Main FAB element -->
    <div class="fab">
      <!-- FAB icon (visible when collapsed) -->
      <div class="fab-icon">
        <svg viewBox="0 0 24 24">
          <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
        </svg>
      </div>

      <!-- History tab handle -->
      <div class="history-tab"></div>

      <!-- Notification peek area -->
      <div class="notification-peek">
        <div class="notification-peek-inner">
          <button class="notification-peek-dismiss">×</button>
          <div class="notification-peek-text"></div>
          <div class="notification-peek-actions"></div>
        </div>
      </div>

      <!-- History panel -->
      <div class="history-panel">
        <div class="history-panel-inner">
          <!-- History header with clear button -->
          <div class="history-header">
            <h3>History</h3>
            <button class="history-clear" onclick="clearHistory()">Clear</button>
          </div>

          <!-- Context pills (tools, sources, attachments) -->
          <div class="context-pills"></div>

          <!-- Chat-style message history -->
          <div class="history-messages">
            <div class="history-items"></div>
          </div>
        </div>
      </div>

      <!-- Composer section -->
      <div class="composer-section">
        <div class="composer">
          <textarea
            placeholder="Type a message..."
            onkeypress="handleEnter(event)"
          ></textarea>
          <button onclick="sendMessage()">Send</button>
        </div>
      </div>

      <!-- Toast notification -->
      <div class="toast">
        <div class="toast-content"></div>
      </div>
    </div>

</div>

<script>
    /* ==========================================================================
       MORPHING FAB - STATE MANAGEMENT & INTERACTION LOGIC
       ==========================================================================

       STATE VARIABLES:
       - isExpanded: FAB is expanded (showing composer)
       - showHistory: Full history panel is visible
       - peekDismissed: User has dismissed the notification peek
       - history: Array of message/notification objects
       - contextItems: Array of tools/sources/attachments to display

       KEY BEHAVIORS:
       - New notifications reset peekDismissed to show peek again
       - Dismissing peek hides it but keeps notification in history
       - Opening history marks peek as dismissed (user has seen it)
       - Closing/reopening composer resets peek dismissed state

       ========================================================================== */

    // DOM element references
    const fab = document.querySelector('.fab');
    const backdrop = document.querySelector('.backdrop');
    const textarea = document.querySelector('.composer textarea');
    const historyItems = document.querySelector('.history-items');
    const contextPills = document.querySelector('.context-pills');
    const toast = document.querySelector('.toast');
    const toastContent = document.querySelector('.toast-content');
    const notificationBubble = document.querySelector('.notification-bubble');
    const notificationContent = document.querySelector('.notification-content');
    const historyTab = document.querySelector('.history-tab');
    const notificationPeek = document.querySelector('.notification-peek');
    const notificationPeekText = document.querySelector('.notification-peek-text');
    const notificationPeekActions = document.querySelector('.notification-peek-actions');
    const notificationPeekDismiss = document.querySelector('.notification-peek-dismiss');

    // State variables
    let isExpanded = false;      // FAB is in expanded state
    let showHistory = false;     // History panel is visible
    let peekDismissed = false;   // User has dismissed the notification peek
    let history = [];            // Message/notification history

    // Mock context items (tools, sources, attachments)
    let contextItems = [
      { type: 'tool', label: 'Web Search', icon: '🔍' },
      { type: 'tool', label: 'Calculator', icon: '🔢' },
      { type: 'source', label: 'docs.anthropic.com', icon: '📄' },
      { type: 'attachment', label: 'image.png', icon: '📎' },
      { type: 'tool', label: 'Code Runner', icon: '⚡' }
    ];

    /* Event Listeners
       ========================================================================== */

    // FAB click: Toggle expanded state (only when clicking FAB itself, not children)
    fab.addEventListener('click', (e) => {
      if (isExpanded && !e.target.classList.contains('fab')) return;
      if (e.target.closest('.history-tab')) return;
      toggleComposer();
    });

    // Backdrop click: Close composer
    backdrop.addEventListener('click', () => {
      if (isExpanded) {
        closeComposer();
      }
    });

    // History tab click: Toggle history panel
    historyTab.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHistory();
    });

    // Notification peek click: Toggle history (unless clicking button)
    notificationPeek.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      e.stopPropagation();
      toggleHistory();
    });

    // Dismiss button: Hide peek without removing notification
    notificationPeekDismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissPeekedNotification();
    });

    // Notification bubble click: Expand composer
    notificationBubble.addEventListener('click', () => {
      if (!isExpanded) {
        isExpanded = true;
        fab.classList.add('expanded');
        backdrop.classList.add('active');
        setTimeout(() => textarea.focus(), 400);
        hideNotificationBubble();
        updateNotificationPeek();
      }
    });

    // ESC key: Close composer
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isExpanded) {
        closeComposer();
      }
    });

    /* Core State Management Functions
       ========================================================================== */

    /**
     * Toggle composer between collapsed and expanded states
     * When expanding: Show composer, hide notification bubble, update peek
     * When collapsing: Delegate to closeComposer()
     */
    function toggleComposer() {
      isExpanded = !isExpanded;

      if (isExpanded) {
        fab.classList.add('expanded');
        backdrop.classList.add('active');
        setTimeout(() => textarea.focus(), 400);
        hideNotificationBubble();
        updateNotificationPeek();
      } else {
        closeComposer();
      }
    }

    /**
     * Close composer and reset all related state
     * Resets peek dismissed flag for next open
     */
    function closeComposer() {
      isExpanded = false;
      showHistory = false;
      peekDismissed = false; // Reset for next time
      fab.classList.remove('expanded', 'with-history', 'has-notification');
      backdrop.classList.remove('active');
    }

    /**
     * Toggle history panel visibility
     * Opening history marks peek as dismissed (user has seen notifications)
     */
    function toggleHistory() {
      showHistory = !showHistory;

      if (showHistory) {
        fab.classList.add('with-history');
        peekDismissed = true; // User is viewing history, so dismiss peek
        updateContextPills();
      } else {
        fab.classList.remove('with-history');
      }
    }

    /**
     * Hide notification peek without removing from history
     * Sets peekDismissed flag to prevent peek from showing again
     * Until new notification arrives or user reopens composer
     */
    function dismissPeekedNotification() {
      peekDismissed = true;
      notificationPeek.classList.add('empty');
      fab.classList.remove('has-notification');
      showToast('Notification hidden');
    }

    /* Input Handling
       ========================================================================== */

    /**
     * Handle Enter key in textarea
     * Enter: Send message
     * Shift+Enter: New line
     */
    function handleEnter(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    }

    /**
     * Send message from textarea
     * Adds to history, shows toast, clears input
     */
    function sendMessage() {
      const message = textarea.value.trim();
      if (!message) return;

      addToHistory({ message, type: 'user' });

      if (isExpanded) {
        showToast(message);
      }

      textarea.value = '';
    }

    /* History Management
       ========================================================================== */

    /**
     * Add item to history and update UI
     * If new notification: Reset peek dismissed flag
     * @param {Object} item - History item with type: 'user' | 'notification'
     */
    function addToHistory(item) {
      // Reset peek dismissed when new notification arrives
      if (item.type === 'notification') {
        peekDismissed = false;
      }

      history.unshift(item);
      updateHistory();
      updateNotificationPeek();
    }

    /**
     * Render all history items as chat bubbles
     * User messages: Right-aligned, dark
     * Notifications: Left-aligned, light with action buttons
     */
    function updateHistory() {
      historyItems.innerHTML = '';

      history.forEach(item => {
        const typeClass = item.type === 'user' ? 'user-message' : 'notification-message';
        const text = item.message || item.text;

        // Create bubble container
        const historyItem = document.createElement('div');
        historyItem.className = `history-item ${typeClass}`;

        // Add message text
        const textDiv = document.createElement('div');
        textDiv.textContent = text;
        historyItem.appendChild(textDiv);

        // Add action buttons for notifications
        if (item.type === 'notification' && item.actions && item.actions.length > 0) {
          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'history-item-actions';

          item.actions.forEach(action => {
            const button = document.createElement('button');
            button.textContent = action.label;
            button.onclick = (e) => {
              e.stopPropagation();
              window[action.handler.replace('()', '')]();
            };
            actionsDiv.appendChild(button);
          });

          historyItem.appendChild(actionsDiv);
        }

        historyItems.appendChild(historyItem);
      });
    }

    /**
     * Clear all history after confirmation
     * Also updates peek to reflect empty state
     */
    function clearHistory() {
      if (history.length === 0) return;

      if (confirm('Clear all history?')) {
        history = [];
        updateHistory();
        updateNotificationPeek();
        showToast('History cleared');
      }
    }

    /* Notification Peek Management
       ========================================================================== */

    /**
     * Update notification peek with latest notification
     * Shows peek only if:
     * - There is a notification
     * - Peek hasn't been dismissed
     * - FAB is expanded
     * - History panel isn't showing
     */
    function updateNotificationPeek() {
      const latestNotification = history.find(item => item.type === 'notification');

      if (latestNotification && !peekDismissed) {
        // Show peek
        notificationPeek.classList.remove('empty');
        fab.classList.add('has-notification');
        notificationPeekText.textContent = latestNotification.text || latestNotification.message;

        // Render action buttons
        if (latestNotification.actions && latestNotification.actions.length > 0) {
          notificationPeekActions.innerHTML = '';

          latestNotification.actions.forEach(action => {
            const button = document.createElement('button');
            button.textContent = action.label;
            button.onclick = (e) => {
              e.stopPropagation();
              window[action.handler.replace('()', '')]();
            };
            notificationPeekActions.appendChild(button);
          });
        } else {
          notificationPeekActions.innerHTML = '';
        }
      } else {
        // Hide peek
        notificationPeek.classList.add('empty');
        fab.classList.remove('has-notification');
        notificationPeekText.textContent = '';
        notificationPeekActions.innerHTML = '';
      }
    }

    /* Context Pills Management
       ========================================================================== */

    /**
     * Render context pills (tools, sources, attachments)
     * Pills appear with staggered animation for visual polish
     */
    function updateContextPills() {
      if (contextItems.length === 0) {
        contextPills.innerHTML = '';
        return;
      }

      contextPills.innerHTML = '';

      contextItems.forEach((item, index) => {
        const pill = document.createElement('div');
        pill.className = 'context-pill';
        pill.style.animationDelay = `${index * 0.05}s`; // Stagger animation
        pill.innerHTML = `<span class="context-pill-icon">${item.icon}</span>${item.label}`;
        pill.onclick = () => {
          showToast(`Opened ${item.label}`);
          console.log('Context pill clicked:', item);
        };
        contextPills.appendChild(pill);
      });
    }

    /* Toast & Notification Bubble
       ========================================================================== */

    /**
     * Show toast message for 3 seconds
     * Used for action feedback
     */
    function showToast(message) {
      toastContent.textContent = message;
      toast.classList.add('show');

      setTimeout(() => {
        toast.classList.remove('show');
      }, 3000);
    }

    /**
     * Show notification bubble above collapsed FAB
     */
    function showNotificationBubble(message) {
      notificationContent.textContent = message;
      notificationBubble.classList.add('show');
    }

    /**
     * Hide notification bubble
     */
    function hideNotificationBubble() {
      notificationBubble.classList.remove('show');
    }

    /* Demo: Notification Simulation
       ========================================================================== */

    /**
     * Simulate incoming notification with rich actions
     * Shows in bubble if FAB closed, in peek if expanded
     */
    function simulateNotification() {
      const notifications = [
        {
          text: 'New message received!',
          actions: [
            { label: 'Reply', handler: 'handleReply()' },
            { label: 'Dismiss', handler: 'handleDismiss()' }
          ]
        },
        {
          text: 'Task "Update documentation" completed',
          actions: [
            { label: 'View', handler: 'handleView()' }
          ]
        },
        {
          text: 'Update available for your app',
          actions: [
            { label: 'Install', handler: 'handleInstall()' },
            { label: 'Later', handler: 'handleLater()' }
          ]
        },
        {
          text: 'Someone mentioned you in #general',
          actions: [
            { label: 'Open', handler: 'handleOpen()' }
          ]
        },
        {
          text: 'Meeting starting in 5 minutes',
          actions: [
            { label: 'Join', handler: 'handleJoin()' },
            { label: 'Snooze', handler: 'handleSnooze()' }
          ]
        }
      ];

      const notification = notifications[Math.floor(Math.random() * notifications.length)];
      notification.type = 'notification';

      addToHistory(notification);

      // Show in appropriate location based on FAB state
      if (isExpanded) {
        showToast(notification.text);
        updateNotificationPeek();
      } else {
        showNotificationBubble(notification.text);
      }
    }

    /* Action Handlers (Demo)
       ========================================================================== */

    function handleReply() {
      showToast('Opening reply...');
    }

    function handleDismiss() {
      dismissPeekedNotification();
    }

    function handleView() {
      showToast('Opening view...');
    }

    function handleInstall() {
      showToast('Installing update...');
    }

    function handleLater() {
      showToast('Reminder set');
    }

    function handleOpen() {
      showToast('Opening...');
    }

    function handleJoin() {
      showToast('Joining meeting...');
    }

    function handleSnooze() {
      showToast('Snoozed for 10 minutes');
    }
  </script>
</body>
</html>
