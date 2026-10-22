import { createDefaultState, validateState, type PluginState } from '../domain/state.ts';

export type SaveStatus = 'saved' | 'saving' | 'error' | 'conflict' | 'readonly';

/** Serializes snapshots. Errors retain the unsaved revision for an explicit retry. */
export class StateStore {
  state: PluginState = createDefaultState();
  status: SaveStatus = 'saved';
  error = '';
  private revision = 0;
  private savedRevision = 0;
  private running: Promise<void> | null = null;
  private disposed = false;
  private notify: () => void;
  private write: (state: PluginState) => Promise<void>;

  constructor(write: (state: PluginState) => Promise<void>, notify: () => void) {
    this.write = write;
    this.notify = notify;
  }

  load(raw: unknown): void {
    try {
      this.state = validateState(raw);
      this.status = 'saved';
      this.error = '';
    } catch (error) {
      this.status = 'readonly';
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.notify();
  }

  get writable(): boolean {
    return !this.disposed && this.canPersist;
  }

  private get canPersist(): boolean { return this.status !== 'readonly' && this.status !== 'conflict'; }

  change(update: (state: PluginState) => void): void {
    if (!this.writable) throw new Error(this.error || 'Состояние доступно только для чтения.');
    update(this.state);
    this.revision++;
    this.status = 'saving';
    this.notify();
    void this.flush();
  }

  async flush(): Promise<void> {
    if (this.running) return this.running;
    if (!this.canPersist || this.revision === this.savedRevision) return;
    this.running = this.pump();
    await this.running;
    this.running = null;
    // A change may have been queued between the pump completing and this continuation.
    if (this.canPersist && this.status !== 'error' && this.revision !== this.savedRevision) await this.flush();
  }

  private async pump(): Promise<void> {
    while (this.canPersist && this.savedRevision !== this.revision) {
      const revision = this.revision;
      const snapshot = JSON.parse(JSON.stringify(this.state)) as PluginState;
      try {
        await this.write(snapshot);
        this.savedRevision = revision;
      } catch (error) {
        this.status = 'error';
        this.error = error instanceof Error ? error.message : String(error);
        this.notify();
        return;
      }
    }
    if (this.canPersist) {
      this.status = 'saved';
      this.error = '';
      this.notify();
    }
  }

  async external(raw: unknown): Promise<void> {
    if (this.running || this.revision !== this.savedRevision) {
      this.status = 'conflict';
      this.error = 'Настройки изменились извне во время локального сохранения. Закройте другие устройства и перезагрузите плагин; автоматическое слияние отключено.';
      this.notify();
      return;
    }
    this.load(raw);
  }

  dispose(): void {
    this.disposed = true;
    void this.flush();
  }
}
