/**
 * KLI Studio — folder picker
 *
 * Browses the *real* local disk through the harness server
 * (`GET /api/fs/dirs`), so a project can be pointed at any folder on this
 * machine. Browsers never expose absolute paths through
 * `<input type="file">`, which is why this dialog goes through `kli serve`
 * instead of the File System Access API.
 */

import { useEffect, useState } from 'react';
import { ChevronUp, Folder, FolderOpen, HardDrive, Home, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { listFolders, type DirListing } from '@/lib/harness';
import { useStore } from '@/store';

export function FolderPicker({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const harnessUrl = useStore((state) => state.harnessUrl);
  const [path, setPath] = useState<string | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listFolders(harnessUrl, path ?? undefined)
      .then((data) => {
        if (cancelled) return;
        setListing(data);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : 'No se pudo leer la carpeta.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [harnessUrl, path]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const joinFolder = (base: string, name: string): string =>
    `${base.replace(/\/+$/, '')}/${name}`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Cerrar selector de carpetas"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Seleccionar carpeta del proyecto"
        className="relative flex h-[min(70vh,520px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl animate-fade-in"
      >
        {/* Ruta actual */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs">{listing?.path ?? '…'}</p>
            <p className="text-[10px] text-muted-foreground">
              El agente trabajará aislado dentro de esta carpeta
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 shrink-0"
            onClick={onClose}
            aria-label="Cerrar"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Atajos */}
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => setPath(listing?.home ?? null)}
          >
            <Home className="h-3 w-3" />
            Inicio
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => setPath(listing?.workspaceRoot ?? null)}
          >
            <HardDrive className="h-3 w-3" />
            Workspace
          </Button>
        </div>

        {/* Lista de carpetas */}
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {error ? (
            <p className="px-4 py-6 text-center text-xs text-destructive">{error}</p>
          ) : loading ? (
            <p className="px-4 py-6 text-center text-xs text-muted-foreground">Cargando carpetas…</p>
          ) : (
            <>
              {listing?.parent ? (
                <button
                  type="button"
                  onClick={() => setPath(listing.parent)}
                  className="flex w-full items-center gap-2 rounded-md px-4 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">Subir una carpeta</span>
                </button>
              ) : null}

              {listing && listing.folders.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Sin subcarpetas — puedes seleccionar esta carpeta.
                </p>
              ) : null}

              {listing?.folders.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  onClick={() => setPath(joinFolder(listing.path, folder))}
                  className="flex w-full items-center gap-2 rounded-md px-4 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{folder}</span>
                </button>
              ))}
            </>
          )}
        </div>

        {/* Acciones */}
        <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="sm" onClick={() => listing && onSelect(listing.path)} disabled={!listing}>
            <FolderOpen className="h-3.5 w-3.5" />
            Seleccionar esta carpeta
          </Button>
        </div>
      </div>
    </div>
  );
}
