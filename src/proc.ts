import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

export function isAlive(pid: number | undefined): boolean {
  if (!pid)
    return false
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function signal(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid)
    return
  try {
    process.kill(pid, sig)
  }
  catch {}
}

/** Signals the whole process group led by `pid`: `pnpm dev` spawns its own children. */
export function signalGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (pid)
    signal(-pid, sig)
}

export async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid)) {
    if (Date.now() > deadline)
      return false
    await sleep(50)
  }
  return true
}
