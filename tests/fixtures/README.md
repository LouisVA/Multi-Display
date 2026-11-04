`clip.webm` is a 0.2 second, 48 by 32 pixel blue video for decoder and resource cleanup checks.

It was generated with an existing FFmpeg installation:

```sh
ffmpeg -f lavfi -i color=c=blue:s=48x32:d=0.2 -an -c:v libvpx clip.webm
```
