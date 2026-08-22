/**
 * Onde isto morava.
 *
 * A implementação foi para server/src/connectors/run.ts porque o worker não entra na imagem
 * publicada e o servidor precisava dela. Reexportado para o worker continuar sendo o lugar de onde
 * um agendador futuro a chama.
 */
export {
  runConnector,
  type ConnectorPersistence,
} from "../../server/src/connectors/run";
