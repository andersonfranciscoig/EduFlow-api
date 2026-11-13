/**
 * Comprovativos de pagamento (dados pessoais e bancários) no UploadThing, cifrados com
 * AES-256-GCM antes de saírem da API. A implementação é partilhada (libs/kernel): o
 * school-api usa a mesma para os documentos do RH, com outra app e outra chave.
 */
export { EncryptedUploadThingFileStorage } from "../../../../../../../libs/kernel/src/infrastructure/encrypted-uploadthing-storage";
