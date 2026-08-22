import { createFileRoute } from "@tanstack/react-router";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Switch } from "@/components/ui/switch";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

function RouteComponent() {
  const { dark, setDark } = useTheme();

  /*
   * The measurements that used to be written out here now live in `PageShell`, which Skills, Admin
   * and this screen all render through. The reason they match is no longer that somebody remembered
   * to copy them.
   */
  return (
    <PageShell
      description="Como o OpenBot aparece e se comporta para você. Vale só para a sua conta, em todo deployment onde você entrar."
      title="Preferences"
    >
      <PageSection title="General">
        <PageRows>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Tema escuro</ItemTitle>
              <ItemDescription>
                Usar a aparência escura em todo o OpenBot.
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label="Tema escuro"
                checked={dark}
                onCheckedChange={setDark}
              />
            </ItemActions>
          </Item>
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
