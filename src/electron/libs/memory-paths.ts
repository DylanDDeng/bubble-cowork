import { homedir } from 'os';
import { join } from 'path';
import { isDev } from '../util';

export function getAegisMemoryHome(): string {
  return join(homedir(), isDev() ? '.aegis-dev' : '.aegis');
}

export function getAegisAssistantRoot(): string {
  return join(getAegisMemoryHome(), 'assistant');
}

export function getAegisProjectsRoot(): string {
  return join(getAegisMemoryHome(), 'projects');
}
