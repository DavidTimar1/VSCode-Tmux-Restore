import * as vscode from 'vscode';
import { collectClients, explainNoMatch, hasProc, matchShell, shq, typable, SocketReport } from './detect';

interface SavedTab {
  name: string;
  session: string;
  socket?: string;
}

interface SavedState {
  savedAt: string;
  tabs: SavedTab[];
}

const KEY = 'tmuxTabRestore.tabs';
const NO_PROC_MSG = 'Tmux Restore needs a Linux host with /proc. Install it in a Remote-SSH window on the Linux server.';

let out: vscode.OutputChannel;
let busy: Promise<unknown> = Promise.resolve();
/** False from window start: auto-save only adds tabs. True once Save or Restore ran in this window session: auto-save replaces the list. */
let replaceMode = false;

function log(s: string): void {
  out.appendLine(`[${new Date().toISOString()}] ${s}`);
}

/** Serialise save and restore runs so they never interleave. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = busy.then(fn, fn);
  busy = run.catch(() => undefined);
  return run;
}

async function shellPid(t: vscode.Terminal): Promise<{ pid?: number; why?: string }> {
  if (t.exitStatus !== undefined) {
    return { why: 'terminal already exited' };
  }
  const pid = await Promise.race([
    Promise.resolve(t.processId),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), 3000)),
  ]);
  if (pid === undefined) {
    return { why: 'processId undefined (extension terminal, not started yet, or timed out after 3 s)' };
  }
  return { pid };
}

function logReports(reports: SocketReport[]): void {
  for (const r of reports) {
    log(`  socket ${r.label}: ${r.note}`);
  }
}

interface Found {
  terminal: vscode.Terminal;
  tab: SavedTab;
}

async function detectAll(what: string): Promise<Found[]> {
  const reports = await collectClients();
  log(`${what}: ${vscode.window.terminals.length} terminal(s) open`);
  logReports(reports);
  const found: Found[] = [];
  for (const t of vscode.window.terminals) {
    const { pid, why } = await shellPid(t);
    if (pid === undefined) {
      log(`  terminal '${t.name}': skipped, ${why}`);
      continue;
    }
    const m = matchShell(pid, reports);
    if (!m) {
      log(`  terminal '${t.name}' shell pid ${pid}: no tmux session, ${explainNoMatch(reports)}`);
      continue;
    }
    log(`  terminal '${t.name}' shell pid ${pid}: matched client pid ${m.clientPid}, session '${m.session}', socket ${m.socket ?? 'default'}`);
    const tab: SavedTab = { name: t.name, session: m.session };
    if (m.socket) {
      tab.socket = m.socket;
    }
    found.push({ terminal: t, tab });
  }
  return found;
}

function load(ctx: vscode.ExtensionContext): SavedTab[] {
  const s = ctx.workspaceState.get<SavedState>(KEY);
  if (!s || !Array.isArray(s.tabs)) {
    return [];
  }
  return s.tabs.filter(
    (t) => t && typeof t.name === 'string' && typeof t.session === 'string' && (t.socket === undefined || typeof t.socket === 'string'),
  );
}

async function save(ctx: vscode.ExtensionContext, manual: boolean): Promise<void> {
  if (!hasProc()) {
    if (manual) {
      void vscode.window.showWarningMessage(NO_PROC_MSG);
    }
    return;
  }
  if (manual) {
    replaceMode = true;
  }
  await exclusive(async () => {
    const mode = replaceMode ? 'replace' : 'merge';
    const what = `${manual ? 'Save (manual)' : 'Save (auto)'}, mode ${mode}`;
    const found = await detectAll(what);
    const detected = found.map((f) => f.tab);
    const existing = load(ctx);
    let tabs = detected;
    if (!manual && detected.length === 0 && existing.length > 0) {
      log(`${what}: no tmux tabs found, kept the ${existing.length} saved tab(s)`);
      return;
    }
    if (!manual && !replaceMode) {
      const keyOf = (t: SavedTab) => `${t.socket ?? ''}\n${t.session}`;
      const known = new Set(existing.map(keyOf));
      const added = detected.filter((t) => !known.has(keyOf(t)));
      tabs = existing.concat(added);
      log(`${what}: ${added.length} new tab(s) added, no entry removed`);
    }
    if (!manual && JSON.stringify(existing) === JSON.stringify(tabs)) {
      return;
    }
    const state: SavedState = { savedAt: new Date().toISOString(), tabs };
    await ctx.workspaceState.update(KEY, state);
    log(`${what}: saved ${tabs.length} tab(s)`);
    if (manual) {
      void vscode.window.showInformationMessage(
        `Tmux Restore: saved ${tabs.length} tab(s)` +
          (tabs.length
            ? `: ${tabs.map((t) => `${t.name} (${t.session})`).join(', ')}`
            : '. No tab is attached to tmux; see "Tmux Restore: Show detection log".'),
      );
    }
  });
}

async function restore(ctx: vscode.ExtensionContext): Promise<void> {
  if (!hasProc()) {
    void vscode.window.showWarningMessage(NO_PROC_MSG);
    return;
  }
  replaceMode = true;
  await exclusive(async () => {
    const saved = load(ctx);
    if (saved.length === 0) {
      log('Restore: nothing saved');
      void vscode.window.showInformationMessage('Tmux Restore: no saved tabs. Run "Tmux Restore: Save tabs" first.');
      return;
    }
    const attached = await detectAll('Restore');
    const have = new Set(attached.map((f) => `${f.tab.socket ?? ''}\n${f.tab.session}`));
    let opened = 0;
    const skipped: string[] = [];
    for (const tab of saved) {
      const key = `${tab.socket ?? ''}\n${tab.session}`;
      if (have.has(key)) {
        skipped.push(`${tab.session} (already open)`);
        log(`  skip '${tab.session}': already attached in a tab of this window`);
        continue;
      }
      if (!typable(tab.session) || (tab.socket !== undefined && !typable(tab.socket))) {
        skipped.push(`${tab.session} (unsafe characters)`);
        log(`  skip ${JSON.stringify(tab.session)}: value contains control characters`);
        continue;
      }
      const cmd = `tmux ${tab.socket ? `-S ${shq(tab.socket)} ` : ''}new-session -A -s ${shq(tab.session)}`;
      const term = vscode.window.createTerminal({ name: tab.session, location: vscode.TerminalLocation.Editor });
      term.sendText(cmd, true);
      have.add(key);
      opened++;
      log(`  restored '${tab.session}' in the editor area: ${cmd}`);
    }
    void vscode.window.showInformationMessage(
      `Tmux Restore: restored ${opened} tab(s)` + (skipped.length ? `, skipped ${skipped.length}: ${skipped.join(', ')}` : ''),
    );
  });
}

export function activate(ctx: vscode.ExtensionContext): void {
  out = vscode.window.createOutputChannel('Tmux Restore');
  ctx.subscriptions.push(out);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('tmuxTabRestore.save', () => save(ctx, true)),
    vscode.commands.registerCommand('tmuxTabRestore.restore', () => restore(ctx)),
    vscode.commands.registerCommand('tmuxTabRestore.showLog', () => out.show(true)),
  );
  if (!hasProc()) {
    log(NO_PROC_MSG);
    return;
  }
  const auto = () => void save(ctx, false).catch((e) => log(`Save (auto) failed: ${e}`));
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(auto, 2000);
  };
  const iv = setInterval(auto, 30000);
  // A tmux command started in a tab: save 2 s and 6 s later, once tmux has attached.
  // Needs shell integration; without it the event never fires and the 30 s timer covers it.
  const tmuxTimers = new Set<NodeJS.Timeout>();
  const onShellStart = (e: vscode.TerminalShellExecutionStartEvent) => {
    if (!e.execution.commandLine.value.trim().startsWith('tmux')) {
      return;
    }
    log(`tmux command started in '${e.terminal.name}', saving in 2 s`);
    for (const ms of [2000, 6000]) {
      const t = setTimeout(() => {
        tmuxTimers.delete(t);
        auto();
      }, ms);
      tmuxTimers.add(t);
    }
  };
  ctx.subscriptions.push(
    vscode.window.onDidOpenTerminal(schedule),
    vscode.window.onDidCloseTerminal(schedule),
    vscode.window.onDidStartTerminalShellExecution(onShellStart),
    {
      dispose: () => {
        if (timer) {
          clearTimeout(timer);
        }
        tmuxTimers.forEach(clearTimeout);
        tmuxTimers.clear();
        clearInterval(iv);
      },
    },
  );
  log('Tmux Restore active on a Linux host');
}

export function deactivate(): void {}
