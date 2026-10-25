"use client";

import { useMemo, useState } from "react";

import { Modal } from "./modal";

export interface PaletteAction {
  id: string;
  group: string;
  label: string;
  hint: string;
  run(): void;
}

export function CommandPalette({
  actions,
  onClose,
}: {
  actions: PaletteAction[];
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    if (!normalized) return actions;
    return actions.filter((action) =>
      `${action.label} ${action.hint} ${action.group}`.toLocaleLowerCase("es").includes(normalized),
    );
  }, [actions, query]);

  const execute = (action: PaletteAction | undefined) => {
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <Modal title="Paleta de comandos" onClose={onClose} className="palette" initialFocus="#palette-input">
      <input
        id="palette-input"
        className="input p-input"
        value={query}
        placeholder="Buscar pantalla o acción…"
        aria-label="Buscar comandos"
        aria-controls="palette-list"
        aria-activedescendant={filtered[selected] ? `palette-${filtered[selected].id}` : undefined}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((value) => Math.min(Math.max(0, filtered.length - 1), value + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            execute(filtered[selected]);
          }
        }}
      />
      <div className="p-list" id="palette-list" role="listbox" aria-label="Comandos disponibles">
        {filtered.length === 0 ? <p className="empty">Ningún comando coincide con la búsqueda.</p> : null}
        {filtered.map((action, index) => (
          <div key={action.id}>
            {(index === 0 || filtered[index - 1]?.group !== action.group) ? (
              <p className="p-group">{action.group}</p>
            ) : null}
            <button
              type="button"
              id={`palette-${action.id}`}
              className="p-item"
              role="option"
              aria-selected={selected === index}
              onMouseEnter={() => setSelected(index)}
              onClick={() => execute(action)}
            >
              <span>{action.label}</span>
              <span className="p-hint">{action.hint}</span>
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
