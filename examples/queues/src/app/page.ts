import { DEMO_MAX_ATTEMPTS, DEMO_RETRY_DELAY } from '../queues.ts';

export const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Composer Queues</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0e1116;
      color: #e8edf4;
      --surface: #151a21;
      --surface-raised: #1b222c;
      --border: #2a3441;
      --muted: #8e9bac;
      --accent: #2dd4bf;
      --accent-strong: #14b8a6;
      --danger: #fb7185;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; background: #0e1116; }
    header {
      height: 64px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      border-bottom: 1px solid var(--border);
      background: #11151b;
    }
    h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; }
    .tag { color: var(--muted); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .topology {
      padding: 24px 28px 28px;
      border-bottom: 1px solid var(--border);
      background: #0e1116;
    }
    .topology-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      max-width: 1120px;
      margin: 0 auto 22px;
    }
    .topology-head h2 { margin-bottom: 5px; font-size: 15px; }
    .topology-head p { max-width: 64ch; margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
    .topology-state {
      display: flex;
      align-items: center;
      flex: none;
      gap: 8px;
      padding-top: 2px;
      color: #b7c2cf;
      font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .topology-state::before {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent);
      content: "";
    }
    .system-map {
      position: relative;
      display: grid;
      grid-template-columns: minmax(210px, 260px) minmax(72px, 1fr) minmax(210px, 240px) minmax(72px, 1fr) minmax(190px, 220px);
      grid-template-rows: 136px 44px 116px;
      max-width: 1120px;
      margin: 0 auto;
    }
    .system-node {
      position: relative;
      z-index: 2;
      display: flex;
      flex-direction: column;
      justify-content: center;
      min-width: 0;
      padding: 16px 18px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
      transition: border-color 180ms ease-out, background 180ms ease-out;
    }
    .worker-node { grid-column: 1; grid-row: 1; }
    .service-node { grid-column: 3; grid-row: 1; }
    .database-node { grid-column: 5; grid-row: 1; }
    .dispatcher-node { grid-column: 3; grid-row: 3; }
    .node-kind {
      margin-bottom: 7px;
      color: var(--muted);
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .system-node strong { overflow: hidden; font-size: 15px; font-weight: 650; text-overflow: ellipsis; }
    .node-description { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.4; }
    .roles { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
    .role {
      padding: 4px 7px;
      border-radius: 5px;
      background: var(--surface-raised);
      color: #bdc8d5;
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .role.consumer-role { color: var(--accent); }
    .connection {
      position: relative;
      align-self: center;
      height: 36px;
      color: var(--muted);
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .enqueue-connection { grid-column: 2; grid-row: 1; }
    .persist-connection { grid-column: 4; grid-row: 1; }
    .connection-label {
      position: absolute;
      top: 0;
      left: 50%;
      white-space: nowrap;
      transform: translateX(-50%);
    }
    .path {
      position: absolute;
      top: 23px;
      right: 0;
      left: 0;
      height: 1px;
      background: var(--border);
      transition: background 180ms ease-out;
    }
    .path::after {
      position: absolute;
      top: -3px;
      right: 0;
      width: 7px;
      height: 7px;
      border-top: 1px solid var(--border);
      border-right: 1px solid var(--border);
      content: "";
      transform: rotate(45deg);
      transition: border-color 180ms ease-out;
    }
    .control-connection {
      position: absolute;
      z-index: 1;
      top: 136px;
      left: 50%;
      width: 1px;
      height: 44px;
      background: var(--border);
      color: var(--muted);
      transition: background 180ms ease-out;
    }
    .control-connection span {
      position: absolute;
      top: 15px;
      left: 10px;
      width: max-content;
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .delivery-connection {
      position: absolute;
      z-index: 1;
      top: 136px;
      left: 12%;
      width: 38%;
      height: 44px;
      border-bottom: 1px solid var(--border);
      border-left: 1px solid var(--border);
      color: var(--muted);
      transition: border-color 180ms ease-out;
    }
    .delivery-connection::before {
      position: absolute;
      top: 0;
      left: -4px;
      width: 7px;
      height: 7px;
      border-top: 1px solid var(--border);
      border-left: 1px solid var(--border);
      content: "";
      transform: rotate(45deg);
      transition: border-color 180ms ease-out;
    }
    .delivery-connection span {
      position: absolute;
      right: 16px;
      bottom: 7px;
      padding: 0 5px;
      background: #0e1116;
      font: 10px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .mobile-path { display: none; }
    .topology[data-flow="enqueue"] .worker-node,
    .topology[data-flow="enqueue"] .service-node,
    .topology[data-flow="enqueue"] .database-node,
    .topology[data-flow="delivery"] .worker-node,
    .topology[data-flow="delivery"] .service-node,
    .topology[data-flow="delivery"] .dispatcher-node {
      border-color: var(--accent-strong);
      background: #14211f;
    }
    .topology[data-flow="retry"] .worker-node,
    .topology[data-flow="retry"] .service-node,
    .topology[data-flow="retry"] .database-node,
    .topology[data-flow="retry"] .dispatcher-node {
      border-color: var(--danger);
      background: #25171d;
    }
    .topology[data-flow="enqueue"] .enqueue-connection .path,
    .topology[data-flow="enqueue"] .persist-connection .path,
    .topology[data-flow="delivery"] .control-connection {
      background: var(--accent);
    }
    .topology[data-flow="enqueue"] .enqueue-connection .path::after,
    .topology[data-flow="enqueue"] .persist-connection .path::after,
    .topology[data-flow="delivery"] .delivery-connection,
    .topology[data-flow="delivery"] .delivery-connection::before {
      border-color: var(--accent);
    }
    .topology[data-flow="enqueue"] .topology-state::before,
    .topology[data-flow="delivery"] .topology-state::before { animation: flow-pulse 700ms ease-out infinite alternate; }
    .topology[data-flow="retry"] .topology-state::before { background: var(--danger); animation: flow-pulse 700ms ease-out infinite alternate; }
    @keyframes flow-pulse { to { opacity: 0.35; } }
    main { display: grid; grid-template-columns: minmax(320px, 42%) minmax(0, 1fr); min-height: 560px; }
    section { padding: 28px; }
    .producer { border-right: 1px solid var(--border); background: #11151b; }
    .consumer { background: #0e1116; }
    .section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22px; }
    h2 { margin: 0; font-size: 14px; font-weight: 650; }
    .section-note { color: var(--muted); font-size: 12px; }
    label { display: block; margin-bottom: 8px; color: #c7d0dc; font-size: 12px; font-weight: 600; }
    textarea, input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
      color: inherit;
      font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      outline: none;
    }
    textarea { min-height: 150px; resize: vertical; padding: 13px; }
    input { height: 42px; padding: 0 12px; }
    textarea:focus, input:focus { border-color: var(--accent-strong); box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.1); }
    .field { margin-bottom: 18px; }
    .check-field {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
    }
    .check-field input { width: 16px; height: 16px; margin: 1px 0 0; accent-color: var(--accent); }
    .check-field label { margin: 0; cursor: pointer; }
    .check-field small { display: block; margin-top: 3px; color: var(--muted); font-weight: 400; line-height: 1.4; }
    .policy {
      margin: -6px 0 18px;
      color: var(--muted);
      font: 11px ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .actions { display: flex; align-items: center; gap: 14px; }
    button {
      height: 42px;
      padding: 0 18px;
      border: 0;
      border-radius: 7px;
      background: var(--accent);
      color: #06231f;
      font: 650 13px inherit;
      cursor: pointer;
    }
    button:disabled { cursor: wait; opacity: 0.55; }
    #result { min-height: 18px; color: var(--muted); font-size: 12px; }
    #result.error { color: var(--danger); }
    .feed { display: grid; gap: 10px; }
    .empty {
      padding: 52px 20px;
      border: 1px dashed var(--border);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      font-size: 13px;
    }
    .message {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px 18px;
      padding: 14px 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
    }
    .payload { overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .time { color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .meta { grid-column: 1 / -1; display: flex; gap: 14px; color: var(--muted); font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .status { color: var(--accent); }
    .status.failed { color: var(--danger); }
    @media (prefers-reduced-motion: reduce) {
      .topology-state::before { animation: none !important; }
      .system-node, .path, .path::after, .control-connection, .delivery-connection, .delivery-connection::before { transition: none; }
    }
    @media (max-width: 900px) {
      .system-map { display: flex; flex-direction: column; gap: 10px; }
      .system-node { min-height: 104px; }
      .connection { align-self: stretch; height: 34px; }
      .path { top: 16px; right: 50%; left: 50%; width: 1px; height: 34px; }
      .path::after { top: 26px; right: -3px; transform: rotate(135deg); }
      .connection-label { top: 7px; left: calc(50% + 12px); transform: none; }
      .dispatcher-node { order: 6; }
      .control-connection, .delivery-connection { display: none; }
      .mobile-path {
        display: block;
        order: 7;
        color: var(--muted);
        text-align: center;
        font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
    }
    @media (max-width: 760px) {
      header, .topology, section { padding-right: 18px; padding-left: 18px; }
      .topology-head { flex-direction: column; gap: 12px; }
      main { grid-template-columns: 1fr; }
      .producer { border-right: 0; border-bottom: 1px solid var(--border); }
    }
  </style>
</head>
<body>
  <header>
    <h1>Composer Queues</h1>
    <div class="tag">queue-demo / messages</div>
  </header>
  <section class="topology" id="topology" data-flow="idle" aria-labelledby="topology-title">
    <div class="topology-head">
      <div>
        <h2 id="topology-title">One application worker, two queue roles</h2>
        <p>The producer commits durable work. The independent dispatcher later pushes it back to the consumer port on the same Compute worker.</p>
      </div>
      <div class="topology-state" id="topology-state">Ready for a message</div>
    </div>
    <div class="system-map">
      <article class="system-node worker-node">
        <span class="node-kind">Application Compute</span>
        <strong>queueDemo</strong>
        <span class="node-description">Hosts the demo UI and application code.</span>
        <div class="roles">
          <span class="role">producer client</span>
          <span class="role consumer-role">consumer port</span>
        </div>
      </article>
      <div class="connection enqueue-connection" aria-hidden="true">
        <span class="connection-label">enqueue</span>
        <i class="path"></i>
      </div>
      <article class="system-node service-node">
        <span class="node-kind">Queue Module</span>
        <strong>queues.service</strong>
        <span class="node-description">Stores messages and coordinates leases.</span>
      </article>
      <div class="connection persist-connection" aria-hidden="true">
        <span class="connection-label">persist</span>
        <i class="path"></i>
      </div>
      <article class="system-node database-node">
        <span class="node-kind">Prisma Postgres</span>
        <strong>queues.db</strong>
        <span class="node-description">Durable messages and delivery state.</span>
      </article>
      <article class="system-node dispatcher-node">
        <span class="node-kind">Always-running Compute</span>
        <strong>queueDispatcher</strong>
        <span class="node-description">Claims work and pushes it over HTTP.</span>
      </article>
      <div class="control-connection" aria-hidden="true"><span>claim + complete</span></div>
      <div class="delivery-connection" aria-hidden="true"><span>HTTP push to consumer</span></div>
      <div class="mobile-path">queueDispatcher claims from queues.service, then pushes HTTP back to the queueDemo consumer port.</div>
    </div>
  </section>
  <main>
    <section class="producer">
      <div class="section-head">
        <h2>Produce</h2>
        <span class="section-note">Persistent enqueue</span>
      </div>
      <form id="producer-form">
        <div class="field">
          <label for="message">Message</label>
          <textarea id="message" name="message">Hello from Prisma Compute</textarea>
        </div>
        <div class="field">
          <label for="count">Copies</label>
          <input id="count" name="count" type="number" min="1" max="50" value="5">
        </div>
        <div class="policy">Retry policy: fixed ${DEMO_RETRY_DELAY} · ${DEMO_MAX_ATTEMPTS} attempts maximum</div>
        <div class="field check-field">
          <input id="fail-first-attempt" name="fail-first-attempt" type="checkbox">
          <label for="fail-first-attempt">
            Fail the first delivery
            <small>The real consumer throws once. Postgres delays the same message before attempt two.</small>
          </label>
        </div>
        <div class="actions">
          <button id="submit" type="submit">Enqueue messages</button>
          <span id="result"></span>
        </div>
      </form>
    </section>
    <section class="consumer">
      <div class="section-head">
        <h2>Consume</h2>
        <span class="section-note" id="feed-count">Waiting for messages</span>
      </div>
      <div class="feed" id="feed"><div class="empty">Enqueue a message to see it consumed by this Compute app.</div></div>
    </section>
  </main>
  <script>
    const form = document.querySelector('#producer-form');
    const button = document.querySelector('#submit');
    const result = document.querySelector('#result');
    const feed = document.querySelector('#feed');
    const feedCount = document.querySelector('#feed-count');
    const topology = document.querySelector('#topology');
    const topologyState = document.querySelector('#topology-state');
    let flowTimer;
    let previousMessageCount;

    function showFlow(flow, label) {
      clearTimeout(flowTimer);
      topology.dataset.flow = flow;
      topologyState.textContent = label;
      flowTimer = setTimeout(() => {
        topology.dataset.flow = 'idle';
        topologyState.textContent = 'Ready for a message';
      }, 1600);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      result.className = '';
      result.textContent = 'Enqueuing…';
      showFlow('enqueue', 'Committing to Postgres');
      try {
        const response = await fetch('/api/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            message: document.querySelector('#message').value,
            count: Number(document.querySelector('#count').value),
            failFirstAttempt: document.querySelector('#fail-first-attempt').checked,
          }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Request failed');
        result.textContent = body.count + ' message' + (body.count === 1 ? '' : 's') + ' accepted';
        await refresh();
      } catch (error) {
        result.className = 'error';
        result.textContent = error instanceof Error ? error.message : 'Request failed';
      } finally {
        button.disabled = false;
      }
    });

    function render(messages) {
      feedCount.textContent = messages.length === 0 ? 'Waiting for messages' : messages.length + ' consumed';
      if (previousMessageCount !== undefined && messages.length > previousMessageCount) {
        const added = messages.slice(0, messages.length - previousMessageCount);
        if (added.some((message) => message.status === 'failed')) {
          showFlow('retry', 'Delivery failed · retry scheduled in ${DEMO_RETRY_DELAY}');
        } else {
          showFlow('delivery', 'Dispatcher delivered ' + added.length + ' message' + (added.length === 1 ? '' : 's'));
        }
      }
      previousMessageCount = messages.length;
      if (messages.length === 0) return;
      feed.replaceChildren(...messages.map((message) => {
        const item = document.createElement('article');
        item.className = 'message';
        const payload = document.createElement('div');
        payload.className = 'payload';
        payload.textContent = message.body.text;
        const time = document.createElement('time');
        time.className = 'time';
        time.textContent = new Date(message.eventAt).toLocaleTimeString();
        const meta = document.createElement('div');
        meta.className = 'meta';
        const state = document.createElement('span');
        state.className = 'status' + (message.status === 'failed' ? ' failed' : '');
        state.textContent = message.status === 'failed' ? 'consumer error' : 'consumed';
        const id = document.createElement('span');
        id.textContent = message.id;
        const attempt = document.createElement('span');
        attempt.textContent = 'attempt ' + message.attempt;
        meta.append(state, id, attempt);
        item.append(payload, time, meta);
        return item;
      }));
    }

    async function refresh() {
      try {
        const response = await fetch('/api/consumed', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json();
        render(body.messages);
      } catch (_) {}
    }

    refresh();
    setInterval(refresh, 750);
  </script>
</body>
</html>`;
