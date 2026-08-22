import type { CopilotChatLabels } from "@copilotkit/react-core/v2";

/**
 * Os rótulos do chat empacotado, em português.
 *
 * A tela `/bot` não desenha o próprio compositor: ela usa o `CopilotChat` que vem da biblioteca, e
 * com ele vêm os textos dela. Por isso a varredura de português deste repositório não os alcança —
 * eles não estão em `app/src`, estão em `node_modules` — e por isso o app inteiro já falava
 * português enquanto a caixa de mensagem ainda dizia "Type a message…".
 *
 * `Partial`, e de propósito: o que está aqui é o que aparece nesta tela. Um rótulo que a biblioteca
 * ganhe numa versão nova continua em inglês até alguém vê-lo, o que é melhor do que uma tradução
 * inventada para um controle que ninguém sabe onde fica.
 */
export const RÓTULOS_DO_CHAT: Partial<CopilotChatLabels> = {
  chatInputPlaceholder: "Escreva uma mensagem…",
  chatDisclaimerText: "A IA pode errar. Confira as informações que importam.",
  chatInputToolbarAddButtonLabel: "Anexar",
  chatInputToolbarToolsButtonLabel: "Ferramentas",
  chatInputToolbarStartTranscribeButtonLabel: "Ditar",
  chatInputToolbarCancelTranscribeButtonLabel: "Cancelar o ditado",
  chatInputToolbarFinishTranscribeButtonLabel: "Terminar o ditado",
  assistantMessageToolbarCopyMessageLabel: "Copiar a mensagem",
  assistantMessageToolbarCopyCodeLabel: "Copiar o código",
  assistantMessageToolbarCopyCodeCopiedLabel: "Copiado",
  assistantMessageToolbarRegenerateLabel: "Responder de novo",
  assistantMessageToolbarReadAloudLabel: "Ler em voz alta",
  assistantMessageToolbarThumbsUpLabel: "Boa resposta",
  assistantMessageToolbarThumbsDownLabel: "Resposta ruim",
  assistantMessageToolbarInspectorLabel: "Ver os detalhes",
  userMessageToolbarCopyMessageLabel: "Copiar a mensagem",
  userMessageToolbarEditMessageLabel: "Editar a mensagem",
  chatToggleOpenLabel: "Abrir o chat",
  chatToggleCloseLabel: "Fechar o chat",
};
