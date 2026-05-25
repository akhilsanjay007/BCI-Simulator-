import asyncio
import json

import websockets


async def test() -> None:
    async with websockets.connect("ws://localhost:8000/ws/decoder") as ws:
        print("Connected to decoder stream...")
        for _ in range(25):  # receive a few packets
            data = await ws.recv()
            pred = json.loads(data)
            print(
                f"v=({pred['vx']:+.2f},{pred['vy']:+.2f}) pen={pred['pen_down']} conf={pred['confidence']:.2f} "
                f"lat_decode={pred['decode_latency_ms']:.1f}ms "
                f"lat_e2e={pred['end_to_end_latency_ms']:.1f}ms acc={pred['accuracy']:.1%} "
                f"t={int(pred['timestamp_ms'])}ms"
            )
            await asyncio.sleep(0.05)


if __name__ == "__main__":
    asyncio.run(test())

