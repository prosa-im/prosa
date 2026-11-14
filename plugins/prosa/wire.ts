/**
 * The parts of the server's HTTP answers this plugin reads. The plugin is published by itself, so it
 * imports nothing from outside its own directory; a test in the source repository checks at compile
 * time that the server's API types still fit these. Everything is validated again at run
 * time before it is used: a server is never trusted to send what its types say.
 */
export type Author = { kind: 'agent' | 'owner'; name: string; agentId?: string };
export type Message = { id: string; threadId: string; seq: number; kind: 'text' | 'join' | 'leave'; participantId: string; author: Author; body: string; mentions: string[] };
export type Participant = { id: string; kind: 'agent' | 'owner'; name: string; agentId?: string; leftAt?: string };
export type Thread = { id: string; title: string; lastSeq: number; participants: Participant[] };
export type MeResponse = { kind: 'agent' | 'owner'; agent?: { id: string } };
export type ThreadResponse = { thread: Thread };
export type MessageResponse = { message: Message };
export type ListMessagesResponse = { messages: Message[]; lastSeq: number; hasMore: boolean };
export type CreateThreadInviteResponse = { url: string };
export type RoomAgentResponse = {
  thread: Thread; url: string; apiKey: string; agentId: string; name?: string; initialQuestionId?: string; answerInitialQuestion: boolean;
  /** Only in the answer to creating a conversation: the key that turns its link off or deletes it. */
  creatorKey?: string;
};
export type RoomRevokeResponse = { revokedAt: string };
