import {
  IconBuildingBank,
  IconChevronRight,
  IconCode,
  IconDeviceDesktop,
  IconKey,
  IconLayoutGrid,
  IconListDetails,
  IconPlugConnected,
  IconPuzzle,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";

export const Route = createFileRoute("/_authed/admin/")({
  component: RouteComponent,
});

/**
 * Grouped by what the decision is about rather than by how the code is organised.
 *
 * "What Bots can reach" is the group an administrator arrives worrying about, so it goes first.
 * Everything in it either grants a capability or fences one in.
 */
const SECTIONS: {
  title: string;
  description: string;
  items: {
    description: string;
    icon: React.ComponentType<{ className?: string }>;
    linkOptions: LinkOptions;
    title: string;
  }[];
}[] = [
  {
    title: "O que os Bots alcançam",
    description: "Tudo que um Bot toca fora deste app, e os limites disso.",
    items: [
      {
        title: "Conectores",
        description: "Os serviços de onde os Bots leem, e quem os conectou.",
        icon: IconPlugConnected,
        linkOptions: { to: "/admin/connectors" },
      },
      {
        title: "Credenciais",
        description: "Chaves e tokens guardados para este deployment.",
        icon: IconKey,
        linkOptions: { to: "/admin/credentials" },
      },
      {
        title: "Limites",
        description: "Regras que decidem o que um Bot nunca pode fazer.",
        icon: IconShieldCheck,
        linkOptions: { to: "/admin/boundaries" },
      },
      {
        title: "Computadores",
        description: "As máquinas onde os Bots rodam as ferramentas deles.",
        icon: IconDeviceDesktop,
        linkOptions: { to: "/admin/computers" },
      },
    ],
  },
  {
    title: "O que os Bots fazem",
    description:
      "Capacidades e peças de interface disponíveis para todos os Bots.",
    items: [
      {
        title: "Plugins",
        description:
          "Habilidades e ferramentas instaladas para o espaço inteiro.",
        icon: IconPuzzle,
        linkOptions: { to: "/admin/plugins" },
      },
      {
        title: "Componentes de interface",
        description: "Peças próprias que um Bot desenha numa conversa.",
        icon: IconLayoutGrid,
        linkOptions: { to: "/admin/components" },
      },
      {
        title: "Playground",
        description:
          "Escreva um componente e veja ele aparecer enquanto digita.",
        icon: IconCode,
        linkOptions: { to: "/admin/playground" },
      },
    ],
  },
  {
    title: "Quem pode entrar",
    description: "",
    items: [
      {
        title: "Pessoas",
        description:
          "Todo mundo que já entrou, quem administra este deployment, e de quem o acesso foi retirado.",
        icon: IconUsers,
        linkOptions: { to: "/admin/people" },
      },
      {
        title: "Provedores de identidade",
        description:
          "O provedor SAML ou OpenID Connect da própria empresa, roteado pelo domínio do e-mail.",
        icon: IconBuildingBank,
        linkOptions: { to: "/admin/identity-providers" },
      },
    ],
  },
  {
    title: "O que aconteceu",
    description: "",
    items: [
      {
        title: "Auditoria",
        description: "Toda ação tomada neste deployment, e por quem.",
        icon: IconListDetails,
        linkOptions: { to: "/admin/audit" },
      },
    ],
  },
];

function RouteComponent() {
  return (
    <PageShell
      description="Configurações que valem para todo mundo neste deployment. Qualquer coisa daqui afeta cada pessoa e cada Bot, que é o que separa isto das suas próprias preferências."
      title="Admin"
    >
      {SECTIONS.map((section) => (
        <PageSection
          description={section.description || undefined}
          key={section.title}
          title={section.title}
        >
          <PageRows>
            {section.items.map((item, index) => (
              <StaggerItem index={index} key={item.title}>
                {/*
                 * The whole row is the link, not a chevron somebody has to aim at: every row here
                 * goes exactly one place, so there is nothing else the row could mean.
                 */}
                <Item
                  render={(props) => <Link {...item.linkOptions} {...props} />}
                  size="sm"
                >
                  <ItemMedia>
                    <item.icon className="size-4 text-muted-foreground" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{item.title}</ItemTitle>
                    <ItemDescription>{item.description}</ItemDescription>
                  </ItemContent>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </Item>
                {index !== section.items.length - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        </PageSection>
      ))}
    </PageShell>
  );
}
