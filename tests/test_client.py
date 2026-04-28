import asyncio
import json

import websockets


async def test():
    async with websockets.connect("ws://localhost:8000/ws/bci-stream") as ws:
        print("Connected to simulator...")
        for _ in range(10):  # receive 10 packets
            data = await ws.recv()
            packet = json.loads(data)
            print(
                f"Received packet @ {packet['timestamp']:.3f} | "
                f"{len(packet['lfp'])} samples × {packet['channels']} channels"
            )
            await asyncio.sleep(0.1)


if __name__ == "__main__":
    asyncio.run(test())
