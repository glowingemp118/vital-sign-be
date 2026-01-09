export class SendMessageDto {
  conversationId: string;
  receiverId: string;
  content: string;
}

export class ReadDto {
  conversationId: string;
}
