import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { useBotNames } from "@/lib/agents/bot-names";
import { setComputerStateMutationOptions } from "@/lib/computers/mutations";
import { computerFleetQueryOptions } from "@/lib/computers/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/computers")({
  component: ComputersPage,
});

function ComputersPage() {
  /** Bot id currently running a stop/reset request. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Reset deletes the browser profile, so it requires confirmation. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const nameFor = useBotNames();

  const fleet = useQuery(computerFleetQueryOptions());
  const setState = useMutation(setComputerStateMutationOptions(queryClient));

  const computers = fleet.data?.computers ?? null;
  const isolation = fleet.data?.isolation ?? null;
  /*
   * One line for either failure. A list that could not be read and an action that was refused are
   * both "this did not work", and the page has one place to say so.
   */
  const problem = fleet.error
    ? "Não foi possível listar os computadores."
    : setState.error
      ? setState.error.message
      : null;

  const run = (botId: string, action: "stop" | "reset") => {
    setBusy(botId);
    setConfirming(null);
    setState.mutate({ action, botId }, { onSettled: () => setBusy(null) });
  };

  return (
    <PageShell
      description="O navegador de cada Bot e o perfil que ele guarda. O perfil é o que mantém um Bot logado amanhã, e zerar um desloga ele de tudo."
      title="Computadores"
    >
      {problem ? (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          role="alert"
        >
          {problem}
        </p>
      ) : null}

      {isolation === "shared" ? (
        <p className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="font-medium">
            Todos os Bots estão dividindo um computador só.
          </span>{" "}
          Eles dividem os logins, os arquivos e a sessão dele, então um Bot
          alcança o que outro entrou. Defina{" "}
          <code>COMPUTER_SUPERVISOR_URL</code> para dar um computador a cada
          Bot.
        </p>
      ) : isolation === "per-bot" ? (
        <p className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm">
          Cada Bot tem um computador só dele: container próprio, arquivos
          próprios e perfil de navegador próprio.
        </p>
      ) : null}

      <PageSection title="Computadores deste deployment">
        {computers === null && problem ? (
          <PageEmpty>Não foi possível carregar a lista.</PageEmpty>
        ) : computers === null ? null : computers.length === 0 ? (
          <PageEmpty>
            Nenhum computador ainda. Um aparece na primeira vez que um Bot abre
            uma página.
          </PageEmpty>
        ) : (
          <PageRows>
            {computers.map((computer, index) => (
              <StaggerItem index={index} key={computer.botId}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle title={computer.botId}>
                      {nameFor(computer.botId)}
                    </ItemTitle>
                    <ItemDescription>
                      {computer.running
                        ? `Navegador rodando desde ${new Date(computer.startedAt ?? "").toLocaleTimeString()}`
                        : "Nenhum navegador rodando. Ele sobe quando o Bot precisar."}
                      {" · "}
                      {computer.egress === undefined
                        ? "Saída não informada"
                        : computer.egress === null
                          ? "Sai direto"
                          : `Sai por ${computer.egress}`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={busy === computer.botId || !computer.running}
                      onClick={() => void run(computer.botId, "stop")}
                      size="sm"
                      variant="outline"
                    >
                      {busy === computer.botId
                        ? "Trabalhando…"
                        : "Parar navegador"}
                    </Button>
                    <Button
                      disabled={busy === computer.botId}
                      onClick={() => setConfirming(computer.botId)}
                      size="sm"
                      variant="outline"
                    >
                      Zerar
                    </Button>
                  </ItemActions>
                </Item>
                {index !== computers.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>

      {/*
       * A DIALOG RATHER THAN AN INLINE CONFIRM. Resetting signs a Bot out of everything it has ever
       * logged into and cannot be undone, and the row it was confirmed on was one of several
       * identical-looking rows. The dialog names the Bot, so the sentence somebody agrees to says
       * which computer it destroys.
       */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        open={confirming !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Zerar o computador de {confirming ? nameFor(confirming) : ""}?
            </DialogTitle>
            <DialogDescription>
              O perfil dele é apagado, então o Bot sai de todo serviço em que
              tinha entrado e começa do zero. Isto não tem volta.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setConfirming(null)}
              size="sm"
              variant="ghost"
            >
              Cancelar
            </Button>
            <Button
              disabled={busy === confirming}
              onClick={() => {
                if (confirming) void run(confirming, "reset");
              }}
              size="sm"
              variant="destructive"
            >
              {busy === confirming ? "Zerando…" : "Zerar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="mt-4 text-muted-foreground text-sm">
        <strong>Parar</strong> fecha o navegador e guarda os logins dele: a
        próxima coisa que o Bot fizer sobe ele de novo de onde parou.{" "}
        <strong>Zerar</strong> apaga o perfil, então o Bot sai de tudo e começa
        do zero. Os dois ficam registrados na{" "}
        <Link className="underline" to="/admin/audit">
          Auditoria
        </Link>
        .
      </p>
    </PageShell>
  );
}
