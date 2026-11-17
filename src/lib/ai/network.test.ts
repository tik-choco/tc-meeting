import { describe, expect, it, vi } from "vitest";
import { rooms } from "./network";

const state = vi.hoisted(() => ({
  node: { joinRoomAsync: vi.fn(), leaveRoom: vi.fn(), sendMessage: vi.fn() },
  getNode: vi.fn(),
  subscribeEvent: vi.fn(),
}));

vi.mock("../mistClient", () => ({
  getNode: state.getNode,
  subscribeEvent: state.subscribeEvent,
  NODE_ID_STORAGE_KEY: "tc-meeting:node-id",
}));

describe("network room adapter", () => {
  it("shares the application node and forwards room-scoped operations and events", async () => {
    state.node.joinRoomAsync.mockResolvedValue(undefined);
    state.getNode.mockResolvedValue(state.node);
    const first = rooms.nodeScope("node-id");
    const second = rooms.nodeScope("node-id");
    const firstEvent = vi.fn();
    const secondEvent = vi.fn();
    first.onEvent(firstEvent);
    second.onEvent(secondEvent);
    await Promise.all([first.init(), second.init()]);
    await first.joinRoom("room-a");
    await second.joinRoom("room-a");
    expect(rooms.nodeIdStorageKey).toBe("tc-meeting:node-id");
    expect(state.getNode).toHaveBeenCalledTimes(1);
    expect(state.node.joinRoomAsync).toHaveBeenCalledTimes(1);
    expect(state.node.joinRoomAsync).toHaveBeenCalledWith("room-a");

    const payload = new Uint8Array([1, 2]);
    first.sendMessage("peer", payload, 0);
    expect(state.node.sendMessage).toHaveBeenCalledWith("peer", payload, 0, "room-a");
    const relay = state.subscribeEvent.mock.calls[0][0] as (event: number, from: string, data: unknown, room: string) => void;
    relay(0, "peer", payload, "other-room");
    expect(firstEvent).not.toHaveBeenCalled();
    relay(0, "peer", payload, "room-a");
    expect(firstEvent).toHaveBeenCalledWith(0, "peer", payload);
    expect(secondEvent).toHaveBeenCalledWith(0, "peer", payload);
    first.leaveRoom("room-a");
    expect(state.node.leaveRoom).not.toHaveBeenCalled();
    second.leaveRoom("room-a");
    expect(state.node.leaveRoom).toHaveBeenCalledWith("room-a");
  });
});
