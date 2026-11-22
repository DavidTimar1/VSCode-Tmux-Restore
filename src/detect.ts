import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface TmuxClient {
  pid: number;
  session: string;
  /** Socket path, or undefined for the default socket. */
  socket: string | undefined;
}

export interface SocketReport {
  label: string;
  socket: string | undefined;
  clients: TmuxClient[];
  note: string;
}

export interface Detection {
  session: string;
  socket: string | undefined;
  clientPid: number;
}

export function hasProc(): boolean {
  return process.platform === 'linux' && fs.existsSync('/proc/self/stat');
}

function tmuxDir(): string | undefined {
  if (typeof process.getuid !== 'function') {
    return undefined;
  }
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);
}

/** Sockets in the per-user tmux directory, other than the default one. */
function extraSockets(): { sockets: string[]; note: string } {
  const dir = tmuxDir();
  if (!dir) {
    return { sockets: [], note: 'no uid available' };
  }
  const uid = process.getuid!();
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
      return { sockets: [], note: `socket dir ${dir} skipped: not a directory owned by uid ${uid} with mode 0700 or stricter` };
    }
  } catch (e) {
    return { sockets: [], note: `cannot stat socket dir ${dir}: ${(e as NodeJS.ErrnoException).code ?? e}` };
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return { sockets: [], note: `cannot read socket dir ${dir}: ${(e as NodeJS.ErrnoException).code ?? e}` };
  }
  const out: string[] = [];
  const skipped: string[] = [];
  for (const n of names) {
    if (n === 'default') {
      continue;
    }
    const p = path.join(dir, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isSocket()) {
        if (st.uid === uid) {
          out.push(p);
        } else {
          skipped.push(`${n} (owner uid ${st.uid})`);
        }
      }
    } catch {
      // ignore entries that vanish
    }
  }
  return { sockets: out, note: `socket dir ${dir}: ${names.length} entries, ${out.length} non-default socket(s)${skipped.length ? `, skipped not owned by uid ${uid}: ${skipped.join(', ')}` : ''}` };
}

function runTmux(socket: string | undefined): Promise<{ stdout: string } | { error: string }> {
  const args = socket ? ['-S', socket] : [];
  args.push('list-clients', '-F', '#{client_pid} #{client_session}');
  return new Promise((resolve) => {
    execFile('tmux', args, { timeout: 5000, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          resolve({ error: 'tmux not found on PATH' });
        } else if ((err as { killed?: boolean }).killed) {
          resolve({ error: 'tmux timed out after 5 s' });
        } else {
          resolve({ error: `tmux failed: ${String(stderr || err.message).trim()}` });
        }
        return;
      }
      resolve({ stdout });
    });
  });
}

/** Query every tmux socket once. */
export async function collectClients(): Promise<SocketReport[]> {
  const reports: SocketReport[] = [];
  const targets: { label: string; socket: string | undefined }[] = [{ label: 'default socket', socket: undefined }];
  const extra = extraSockets();
  for (const s of extra.sockets) {
    targets.push({ label: s, socket: s });
  }
  for (const t of targets) {
    const r = await runTmux(t.socket);
    if ('error' in r) {
      reports.push({ label: t.label, socket: t.socket, clients: [], note: r.error });
      continue;
    }
    const clients: TmuxClient[] = [];
    for (const line of r.stdout.split('\n')) {
      const m = /^(\d+) (.*)$/.exec(line.trimEnd());
      if (m) {
        clients.push({ pid: Number(m[1]), session: m[2], socket: t.socket });
      }
    }
    reports.push({
      label: t.label,
      socket: t.socket,
      clients,
      note: clients.length === 0 ? 'no clients attached (or no server running)' : `${clients.length} client(s)`,
    });
  }
  reports.push({ label: 'socket scan', socket: undefined, clients: [], note: extra.note });
  return reports;
}

function parentOf(pid: number): number | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    return Number.isFinite(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}

function descendsFrom(pid: number, ancestor: number): boolean {
  let cur: number | undefined = pid;
  for (let i = 0; i < 64 && cur !== undefined && cur > 1; i++) {
    if (cur === ancestor) {
      return true;
    }
    cur = parentOf(cur);
  }
  return cur === ancestor;
}

/** Find the first client whose process chain reaches the shell pid. */
export function matchShell(shellPid: number, reports: SocketReport[]): Detection | undefined {
  for (const r of reports) {
    for (const c of r.clients) {
      if (c.pid === shellPid || descendsFrom(c.pid, shellPid)) {
        return { session: c.session, socket: c.socket, clientPid: c.pid };
      }
    }
  }
  return undefined;
}

/** Explain why nothing matched, in one specific sentence. */
export function explainNoMatch(reports: SocketReport[]): string {
  if (reports.some((r) => r.note.startsWith('tmux not found'))) {
    return 'no tmux on PATH of the extension host';
  }
  const total = reports.reduce((n, r) => n + r.clients.length, 0);
  if (total === 0) {
    return 'no tmux clients attached on any socket (default or socket dir)';
  }
  return `no ancestor match: none of the ${total} tmux client(s) descends from this shell pid`;
}

/** Single-quote a value for bash. */
export function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** True when a value is safe to type into a terminal (no control characters). */
export function typable(s: string): boolean {
  return s.length > 0 && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(s);
}

