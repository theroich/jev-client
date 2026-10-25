"use client";

import { useRef, useState, type KeyboardEvent } from "react";

import {
  DEFAULT_TEMPLATE_STARTER,
  TEMPLATE_STARTERS,
  type TemplateStarterId,
} from "../../dist/src/template-starters.js";
import { Modal } from "./modal";
import { Button, Icon } from "./ui";

const LAST_INDEX = TEMPLATE_STARTERS.length - 1;

/** Modal «Empezar plantilla»: elige el ejemplo que inicializa el body JSON. */
export function TemplateStarterModal({
  onChoose,
  onClose,
}: {
  onChoose(id: TemplateStarterId): void;
  onClose(): void;
}) {
  const [selected, setSelected] = useState<TemplateStarterId>(DEFAULT_TEMPLATE_STARTER);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, TEMPLATE_STARTERS.findIndex((starter) => starter.id === selected));

  const selectIndex = (index: number) => {
    const next = (index + TEMPLATE_STARTERS.length) % TEMPLATE_STARTERS.length;
    const starter = TEMPLATE_STARTERS[next];
    if (!starter) return;
    setSelected(starter.id);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        selectIndex(selectedIndex + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        selectIndex(selectedIndex - 1);
        break;
      case "Home":
        event.preventDefault();
        selectIndex(0);
        break;
      case "End":
        event.preventDefault();
        selectIndex(LAST_INDEX);
        break;
      case "Enter":
        event.preventDefault();
        onChoose(selected);
        break;
    }
  };

  return (
    <Modal
      title="Empezar plantilla"
      initialFocus={`#starter-${DEFAULT_TEMPLATE_STARTER}`}
      onClose={onClose}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={() => onChoose(selected)}>Crear plantilla</Button>
      </>}
    >
      <p className="modal-description">Elige el tipo de pregunta. El editor seguirá siendo libre: el ejemplo solo inicializa el JSON y se puede cambiar después.</p>
      <div className="starter-grid" role="radiogroup" aria-label="Tipo de pregunta inicial" onKeyDown={onKeyDown}>
        {TEMPLATE_STARTERS.map((starter, index) => {
          const checked = starter.id === selected;
          return (
            <button
              key={starter.id}
              ref={(element) => { buttons.current[index] = element; }}
              type="button"
              id={`starter-${starter.id}`}
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="starter-card"
              onClick={() => setSelected(starter.id)}
            >
              <span className="starter-head">
                <span className="starter-label">{starter.label}</span>
                {checked ? <Icon name="check" /> : null}
              </span>
              <span className="starter-desc">{starter.description}</span>
              <span className="starter-meta">
                <span className="starter-answer">{starter.answerType}</span>
                <code className="starter-code">{starter.criteriaShape}</code>
              </span>
            </button>
          );
        })}
      </div>
      <p className="hint">Atajos: flechas para cambiar de tipo, <kbd className="kbd">Enter</kbd> para crear y <kbd className="kbd">Esc</kbd> para cancelar.</p>
    </Modal>
  );
}
