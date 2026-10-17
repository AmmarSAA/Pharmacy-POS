# Usage: python tts.py <voice> <text-file> <out.mp3>
# Neural text-to-speech via edge-tts (pip install edge-tts). Set TTS_CA_BUNDLE when behind a TLS-inspecting proxy.
import asyncio, os, sys
import certifi
if os.environ.get('TTS_CA_BUNDLE'):
    certifi.where = lambda: os.environ['TTS_CA_BUNDLE']
import edge_tts

voice, src, out = sys.argv[1:4]
rate = os.environ.get('TTS_RATE', '-4%')

async def main():
    await edge_tts.Communicate(open(src, encoding='utf-8').read(), voice, rate=rate).save(out)

asyncio.run(main())
