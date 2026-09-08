import { expect, it, vi } from "vitest";
import { createNativePlayer } from "../src/lib/native-player";

it("keeps native video source, controls, tracks and event lifecycle usable", async () => {
  const video = document.createElement("video");
  const play = vi.spyOn(video, "play").mockResolvedValue();
  vi.spyOn(video, "pause").mockImplementation(() => {});
  const load = vi.spyOn(video, "load").mockImplementation(() => {});
  video.setAttribute("crossorigin", "anonymous");
  const player = createNativePlayer(video);
  player.src({ src: "/media/whos-next/000014.mp4", type: "video/mp4" });
  await player.play();
  expect(play).toHaveBeenCalledOnce();
  expect(video.controls).toBe(true);
  expect(video.playsInline).toBe(true);
  expect(video.hasAttribute("crossorigin")).toBe(false);
  expect(video.getAttribute("src")).toBe("/media/whos-next/000014.mp4");
  player.addRemoteTextTrack({ kind: "subtitles", src: "/media/whos-next/000014.en.vtt", srclang: "en", label: "English" }, false);
  expect(player.remoteTextTracks().length).toBe(1);
  const ended = vi.fn(); player.on("ended", ended);
  video.dispatchEvent(new Event("ended"));
  expect(ended).toHaveBeenCalledOnce();
  player.reset();
  expect(video.hasAttribute("src")).toBe(false);
  expect(player.remoteTextTracks().length).toBe(0);
  expect(load).toHaveBeenCalledOnce();
  player.dispose(); video.dispatchEvent(new Event("ended"));
  expect(ended).toHaveBeenCalledOnce();
});
