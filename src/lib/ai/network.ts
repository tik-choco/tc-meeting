import { createRoomConsumers, createSharedNodeScope, type MistDelivery, type MistNodeLike, type RoomConsumers } from "@tik-choco/mistai";
import { getNode, NODE_ID_STORAGE_KEY, subscribeEvent } from "../mistClient";

// All room consumers share the application's single underlying node.
class MeetingMistNode implements MistNodeLike {
  private node: Awaited<ReturnType<typeof getNode>> | undefined;
  private handler: Parameters<MistNodeLike["onEvent"]>[0] | undefined;

  async init(): Promise<void> {
    this.node = await getNode();
    subscribeEvent((...args) => this.handler?.(...args));
  }
  onEvent(handler: Parameters<MistNodeLike["onEvent"]>[0]): void { this.handler = handler; }
  joinRoom(room: string): Promise<void> { return this.joinRoomAsync(room); }
  async joinRoomAsync(room: string): Promise<void> { await this.node!.joinRoomAsync(room); }
  leaveRoom(room?: string): void { if (room) this.node?.leaveRoom(room); }
  sendMessage(to: string | null | undefined, payload: Uint8Array, delivery?: MistDelivery, room?: string): void {
    this.node?.sendMessage(to, payload, delivery, room);
  }
}

export const rooms: RoomConsumers = createRoomConsumers(createSharedNodeScope(() => new MeetingMistNode()), {
  nodeIdStorageKey: NODE_ID_STORAGE_KEY,
});
