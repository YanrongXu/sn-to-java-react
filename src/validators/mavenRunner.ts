import { spawn } from 'child_process';
import * as vscode from 'vscode';
import { ValidationIssue } from '../pipeline/types';

/**
 * Spawns a Maven invocation and parses its output into structured issues.
 * Gracefully reports if Maven isn't available; never throws to the caller.
 */
export async function runMaven(args: {
  cwd: string;
  goals: string[];
  out: vscode.OutputChannel;
  token: vscode.CancellationToken;
}): Promise<{ ran: boolean; success: boolean | null; issues: ValidationIssue[] }> {
  const { cwd, goals, out, token } = args;
  return new Promise(resolve => {
    let mvn;
    try {
      mvn = spawn('mvn', ['-B', '-ntp', ...goals], { cwd, env: process.env });
    } catch (e) {
      out.appendLine(`[stage5:mvn] could not spawn mvn: ${(e as Error).message}`);
      return resolve({ ran: false, success: null, issues: [] });
    }

    const issues: ValidationIssue[] = [];
    let buffer = '';

    const handleLine = (line: string) => {
      out.appendLine(`[mvn] ${line}`);
      // [ERROR] /path/to/File.java:[12,34] cannot find symbol
      const javac = line.match(/^\[ERROR\]\s+(.+?\.java):\[(\d+),\d+\]\s+(.+)$/);
      if (javac) {
        issues.push({ source: 'mvn', severity: 'error', file: javac[1], line: Number(javac[2]), message: javac[3] });
        return;
      }
      // [WARNING] /path/to/File.java:[12,34] note: ...
      const warn = line.match(/^\[WARNING\]\s+(.+?\.java):\[(\d+),\d+\]\s+(.+)$/);
      if (warn) {
        issues.push({ source: 'mvn', severity: 'warning', file: warn[1], line: Number(warn[2]), message: warn[3] });
        return;
      }
      // CheckStyle: [ERROR] File.java:12: <message>
      const checkstyle = line.match(/^\[ERROR\]\s+(.+?\.java):(\d+):\s*(.+)$/);
      if (checkstyle) {
        issues.push({ source: 'checkstyle', severity: 'error', file: checkstyle[1], line: Number(checkstyle[2]), message: checkstyle[3] });
        return;
      }
      // SpotBugs: H/M/L BUG: <type> <message> at <File>.java:[line <n>]
      const spotbugs = line.match(/^\s*[HMLN]\s+BUG:\s+(.+?)\s+at\s+(.+?\.java):\[line\s+(\d+)\]/);
      if (spotbugs) {
        issues.push({ source: 'spotbugs', severity: 'warning', file: spotbugs[2], line: Number(spotbugs[3]), message: spotbugs[1] });
      }
    };

    let pendingOut = '';
    let pendingErr = '';
    mvn.stdout.on('data', (chunk: Buffer) => {
      pendingOut += chunk.toString();
      let i;
      while ((i = pendingOut.indexOf('\n')) >= 0) {
        const line = pendingOut.slice(0, i).replace(/\r$/, '');
        pendingOut = pendingOut.slice(i + 1);
        handleLine(line);
      }
    });
    mvn.stderr.on('data', (chunk: Buffer) => {
      pendingErr += chunk.toString();
      let i;
      while ((i = pendingErr.indexOf('\n')) >= 0) {
        const line = pendingErr.slice(0, i).replace(/\r$/, '');
        pendingErr = pendingErr.slice(i + 1);
        handleLine(line);
      }
    });

    const onCancel = token.onCancellationRequested(() => {
      try { mvn.kill('SIGTERM'); } catch { /* noop */ }
    });

    mvn.on('error', err => {
      onCancel.dispose();
      out.appendLine(`[stage5:mvn] mvn not available: ${err.message}`);
      resolve({ ran: false, success: null, issues: [] });
    });

    mvn.on('close', code => {
      onCancel.dispose();
      if (pendingOut) handleLine(pendingOut);
      if (pendingErr) handleLine(pendingErr);
      resolve({ ran: true, success: code === 0, issues });
    });
  });
}
