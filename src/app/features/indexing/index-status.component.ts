import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IndexService } from '../../core/index.service';
import { VaultService } from '../../core/vault.service';

@Component({
  selector: 'app-index-status',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hasVault()) {
      <div class="flex items-center gap-2 text-xs text-text-muted">
        @if (isIndexing()) {
          <span class="inline-flex items-center gap-1 text-accent">
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"></span>
            Indexing…
          </span>
        } @else {
          <span title="Indexed files / chunks">{{ status().indexedFiles }} files · {{ status().totalChunks }} chunks</span>
          <span class="text-text-muted/60">·</span>
          <span [title]="lastIndexedTitle()">Last: {{ lastIndexedLabel() }}</span>
        }
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title="Rebuild index"
          [disabled]="isIndexing()"
          (click)="onRebuild()">Rebuild</button>
      </div>
    }
  `,
})
export class IndexStatusComponent {
  private readonly indexer = inject(IndexService);
  private readonly vault = inject(VaultService);

  readonly status = this.indexer.status;
  readonly isIndexing = this.indexer.isIndexing;
  readonly hasVault = this.vault.hasVault;

  readonly lastIndexedLabel = computed(() => {
    const ts = this.status().lastIndexedAt;
    if (!ts) return 'never';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ts).toLocaleDateString();
  });

  readonly lastIndexedTitle = computed(() => {
    const ts = this.status().lastIndexedAt;
    return ts ? new Date(ts).toLocaleString() : 'never';
  });

  async onRebuild(): Promise<void> {
    await this.indexer.rebuild(this.vault.vaultPath());
  }
}
