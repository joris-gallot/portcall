import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

export function portcallHome(): string {
  return process.env.PORTCALL_HOME || join(homedir(), '.portcall')
}

export function statePath(): string {
  return join(portcallHome(), 'state.json')
}

export function projectsPath(): string {
  return join(portcallHome(), 'projects.json')
}

export function logPath(project: string, service: string): string {
  return join(portcallHome(), 'logs', project, `${service}.log`)
}
