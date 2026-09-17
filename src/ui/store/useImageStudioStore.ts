import { create } from 'zustand';
import type { ImageComment } from '../utils/image-studio';

export interface ImageStudioState {
  activePath: string;
  activePendingId?: string;
  view: 'single' | 'canvas';
  selected: string[];
  comments: Record<string, ImageComment[]>;
  pending?: { id: string; baseline: string[]; queued: boolean; sawRunning: boolean; startedAt: number; resultPath?: string };
  feedback?: string;
}
const empty = (): ImageStudioState => ({ activePath: '', view: 'single', selected: [], comments: {} });
interface ImageStudioStore {
  sessions: Record<string, ImageStudioState>;
  patch: (sessionId: string, update: Partial<ImageStudioState>) => void;
  comment: (sessionId: string, path: string, comment: ImageComment | null, id: string) => void;
}
// Metadata only, scoped by session. Panel remounts preserve selection and comments.
export const useImageStudioStore = create<ImageStudioStore>((set) => ({
  sessions: {},
  patch: (id, update) => set(state => ({ sessions: { ...state.sessions, [id]: { ...(state.sessions[id] || empty()), ...update } } })),
  comment: (id, path, comment, key) => set(state => {
    const current = state.sessions[id] || empty();
    const prior = current.comments[path] || [];
    const notes = comment?.text.trim()
      ? prior.some(note => note.id === key) ? prior.map(note => note.id === key ? comment : note) : [...prior, comment]
      : prior.filter(note => note.id !== key);
    return { sessions: { ...state.sessions, [id]: { ...current, comments: { ...current.comments, [path]: notes } } } };
  }),
}));
export const EMPTY_IMAGE_STUDIO = empty();
