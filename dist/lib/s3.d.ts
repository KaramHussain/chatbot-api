export declare function getPresignedUploadUrl(params: {
    key: string;
    contentType: string;
    fileSizeLimit?: number;
}): Promise<string>;
export declare function getPresignedDownloadUrl(key: string): Promise<string>;
export declare function deleteObject(key: string): Promise<void>;
export declare function buildDocumentKey(params: {
    tenantId: string;
    botId: string;
    documentId: string;
    filename: string;
}): string;
export declare function buildLogoKey(tenantId: string, botId: string, ext: string): string;
export declare function putObject(key: string, body: Buffer, contentType: string): Promise<void>;
export declare function getObjectStream(key: string): Promise<{
    body: ReadableStream;
    contentType: string;
}>;
//# sourceMappingURL=s3.d.ts.map