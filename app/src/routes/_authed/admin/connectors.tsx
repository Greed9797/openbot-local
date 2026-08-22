import { IconBrandGoogleDrive, IconCloud } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { connectorListQueryOptions } from "@/lib/connectors/queries";

export const Route = createFileRoute("/_authed/admin/connectors")({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  const connectors = useQuery(connectorListQueryOptions());
  return (
    <PageShell
      description="As integrações disponíveis são definidas pelas fontes de conhecimento deste deployment."
      title="Conectores"
    >
      <PageSection title="Disponíveis">
        {connectors.isPending ? null : connectors.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Não foi possível carregar os conectores.
          </p>
        ) : connectors.data?.length === 0 ? (
          <PageEmpty>
            Nenhum conector. Eles vêm das fontes de conhecimento deste
            deployment.
          </PageEmpty>
        ) : (
          <PageRows>
            {connectors.data?.map((connector, index) => (
              <StaggerItem index={index} key={connector.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {connector.type === "google_drive" ? (
                      <IconBrandGoogleDrive />
                    ) : (
                      <IconCloud />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{connector.name}</ItemTitle>
                    <ItemDescription>
                      {/*
                       * A conta conectada em vez de "Configurado", quando existe uma.
                       *
                       * "Configurado" só dizia que uma credencial fora guardada — apareceu do mesmo
                       * jeito para uma chave que nunca tinha falado com o Google. O nome da conta só
                       * pode estar aqui se o Google confirmou de quem ela é.
                       */}
                      {connector.account
                        ? `Conectado como ${connector.account}`
                        : connector.configured
                          ? "Configurado"
                          : "Não conectado"}
                      {" · "}
                      {connector.roots.length > 0
                        ? `Pastas: ${connector.roots.join(", ")}`
                        : "Drive inteiro"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {connector.type === "google_drive" ? (
                      <Button
                        render={<Link to="/admin/connectors/google-drive" />}
                        size="sm"
                        variant="outline"
                      >
                        {connector.account ? "Gerenciar" : "Conectar"}
                      </Button>
                    ) : (
                      // Dito, em vez de deixado em branco, que se leria como um controle a caminho.
                      <span className="text-muted-foreground text-sm">
                        Sem tela de configuração ainda
                      </span>
                    )}
                  </ItemActions>
                </Item>
                {index !== (connectors.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}
