import { type ReactNode, useState } from "react";

/**
 * Conversa + Histórico do bot.
 *
 * Controlled by the parent (`value`/`onValueChange`), not by itself: the
 * parent owns which tab is open so opening an old conversation can jump to
 * it. Both panels stay mounted so a draft typed in Conversa survives a visit
 * to Histórico and back.
 */
export function BotTabs({
  conversa,
  historico,
  value,
  onValueChange,
}: {
  conversa: ReactNode;
  historico: ReactNode;
  value?: "conversa" | "historico";
  onValueChange?: (tab: "conversa" | "historico") => void;
}) {
  const [interna, setInterna] = useState<"conversa" | "historico">("conversa");
  const aba = value ?? interna;
  const trocar = (next: "conversa" | "historico") => {
    setInterna(next);
    onValueChange?.(next);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b px-4 pt-2" role="tablist">
        <button
          aria-selected={aba === "conversa"}
          className={`rounded-t-md px-3 py-2 text-sm font-medium ${
            aba === "conversa"
              ? "bg-foreground/5 text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => trocar("conversa")}
          role="tab"
          type="button"
        >
          Conversa
        </button>
        <button
          aria-selected={aba === "historico"}
          className={`rounded-t-md px-3 py-2 text-sm font-medium ${
            aba === "historico"
              ? "bg-foreground/5 text-foreground"
              : "text-muted-foreground"
          }`}
          onClick={() => trocar("historico")}
          role="tab"
          type="button"
        >
          Histórico
        </button>
      </div>
      <div
        aria-hidden={aba !== "conversa"}
        className={aba === "conversa" ? "min-h-0 flex-1" : "hidden"}
        role="tabpanel"
      >
        {conversa}
      </div>
      <div
        aria-hidden={aba !== "historico"}
        className={aba === "historico" ? "min-h-0 flex-1" : "hidden"}
        role="tabpanel"
      >
        {historico}
      </div>
    </div>
  );
}
