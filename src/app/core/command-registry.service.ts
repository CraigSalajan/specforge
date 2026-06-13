import { Injectable, computed, signal } from '@angular/core';

/**
 * A single palette-invokable action. `when` is evaluated inside a reactive
 * context (the `enabledCommands` computed), so guards that read signals —
 * `() => vault.hasVault()` — keep the palette list live while it is open.
 */
export interface Command {
  /** Stable unique id, e.g. `vault.newFile`. Re-registering an id replaces it. */
  id: string;
  /** Human-readable title shown in the palette, e.g. "New file…". */
  title: string;
  /** Optional grouping label rendered dimmed next to the title. */
  category?: string;
  /** Optional display-only shortcut hint, e.g. "Ctrl+P". */
  shortcut?: string;
  /** Enablement guard; omitted means always enabled. */
  when?: () => boolean;
  run: () => void | Promise<void>;
}

/**
 * App-wide command registry behind the command palette (Ctrl+Shift+P).
 * Supports late registration: any component or service can contribute
 * commands at any time; the palette lists whatever is currently enabled.
 * Plain Map + version-tick signal — commands themselves are not reactive
 * state, only the set membership and the `when` guards are.
 */
@Injectable({ providedIn: 'root' })
export class CommandRegistryService {
  private readonly commands = new Map<string, Command>();
  private readonly version = signal(0);

  /** Currently enabled commands, in registration order. */
  readonly enabledCommands = computed<Command[]>(() => {
    this.version();
    return [...this.commands.values()].filter((command) => command.when?.() ?? true);
  });

  /**
   * Registers `commands` (last registration wins per id) and returns a
   * disposer that removes exactly these instances — a later re-registration
   * of the same id is not torn down by a stale disposer.
   */
  register(...commands: Command[]): () => void {
    for (const command of commands) {
      this.commands.set(command.id, command);
    }
    this.bump();
    return () => {
      let removed = false;
      for (const command of commands) {
        if (this.commands.get(command.id) === command) {
          this.commands.delete(command.id);
          removed = true;
        }
      }
      if (removed) this.bump();
    };
  }

  /** Runs a command by id; no-op for unknown ids or a failing `when` guard. */
  async run(id: string): Promise<void> {
    const command = this.commands.get(id);
    if (!command) return;
    if (command.when && !command.when()) return;
    await command.run();
  }

  private bump(): void {
    this.version.update((n) => n + 1);
  }
}
