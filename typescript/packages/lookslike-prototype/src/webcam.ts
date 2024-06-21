import * as THREE from "three";
import { signal } from "@commontools/common-frp";
const { state } = signal;

export const webcamVideoTexture = state(null as THREE.VideoTexture | null);

if ('mediaDevices' in navigator) {
  navigator.mediaDevices
    .enumerateDevices()
    .then((devices) => {
      const videoDevices = devices.filter(
        (device) => device.kind === "videoinput"
      );
      const faceCam = videoDevices.find((device) =>
        device.label.includes("FaceTime")
      );
      const deviceId = faceCam ? faceCam.deviceId : videoDevices[0]?.deviceId;

      if (deviceId) {
        navigator.mediaDevices
          .getUserMedia({
            video: { deviceId: { exact: deviceId } }
          })
          .then((stream) => {
            const video = document.createElement("video");
            video.autoplay = true;
            video.muted = true;
            video.srcObject = stream;
            video.play();
            video.addEventListener("playing", () => {
              const texture = new THREE.VideoTexture(video);
              texture.minFilter = THREE.LinearFilter;
              texture.magFilter = THREE.LinearFilter;
              texture.format = THREE.RGBFormat;
              texture.needsUpdate = true;
              console.log("Webcam feed loaded", texture);
              webcamVideoTexture.send(texture);
            });
          })
          .catch((error) => {
            console.error("Error accessing webcam:", error);
          });
      }
    })
    .catch((error) => {
      console.error("Error accessing webcam:", error);
    });
}