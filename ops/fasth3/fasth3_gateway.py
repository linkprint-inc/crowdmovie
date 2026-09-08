#!/usr/bin/env python3
"""LAN-only fixed-workflow gateway for CrowdMovie's FastH3 ComfyUI runtime."""

from __future__ import annotations

import copy
import base64
import hashlib
import json
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOST = os.environ.get("FASTH3_GATEWAY_HOST", "127.0.0.1")
PORT = int(os.environ.get("FASTH3_GATEWAY_PORT", "8191"))
ALLOWED_CLIENTS = {
    item.strip()
    for item in os.environ.get("FASTH3_ALLOWED_CLIENTS", "127.0.0.1").split(",")
    if item.strip()
}
PUBLIC_BASE_URL = os.environ.get(
    "FASTH3_PUBLIC_BASE_URL", f"http://{HOST}:{PORT}"
).rstrip("/")
WORKFLOW_PATH = Path(
    os.environ.get("FASTH3_WORKFLOW_PATH", "/opt/comfyui-fasth3/gateway/workflow_api.json")
)
OUTPUT_ROOT = Path(
    os.environ.get("FASTH3_OUTPUT_ROOT", "/opt/comfyui-fasth3/ComfyUI/output")
).resolve()
COMFY_URL = os.environ.get("FASTH3_COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
STATE_PATH = Path(
    os.environ.get(
        "FASTH3_STATE_PATH", "/var/lib/crowdmovie-fasth3/jobs.json"
    )
)
GENERATION_TIMEOUT_SECONDS = float(
    os.environ.get("FASTH3_GENERATION_TIMEOUT_SECONDS", "1800")
)
JOB_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
ALLOWED_SIZES = {(1344, 768)}
CAPABILITIES_VERSION = "h3-capabilities-v6"
LEGACY_CAPABILITIES_VERSION = "h3-capabilities-v5"
FPS = 24
MIN_DURATION_SECONDS = 5
MAX_DURATION_SECONDS = 15
H3_PROMPT_MAX_ENGLISH_WORDS = 2_000
FILM_PROMPT_MAX_ENGLISH_WORDS = 8_000
H3_PROMPT_MAX_CHARACTERS = 128_000
STYLE_PROFILE = "whos-next-causal-cg-v1"
CHARACTER_PROFILE = "whos-next-famous-cast-v3"
ENGLISH_WORD_RE = re.compile(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*")
FORBIDDEN_CAMERA_MOTION_RE = re.compile(
    r"\b(?:fast|rapid|high-speed)\s+(?:(?:single-axis|large[- ]amplitude|wide)\s+)?"
    r"(?:tracking(?: rush)?|track|push(?:-in)?|pull(?:-out)?|orbit|arc|pan|whip(?:-pan)?|"
    r"crane|tilt|camera (?:move|movement|rush))\b|"
    r"\b(?:camera|shot|view)\b[^.!?\n]{0,120}\blarge[- ]amplitude\b|"
    r"\b(?:camera|shot|view)\b[^.!?\n]{0,120}\bat fast speed\b|\bwhip[- ]?pan\b",
    re.IGNORECASE,
)
ALLOWED_NODE_COUNTS = {
    "UNETLoader": 1,
    "CLIPLoader": 1,
    "VAELoader": 2,
    "MiniMaxH3SigmaShift": 1,
    "MiniMaxH3PDDAccApply": 1,
    "MiniMaxH3ImageToVideo": 1,
    "RandomNoise": 1,
    "BasicGuider": 1,
    "KSamplerSelect": 1,
    "SamplerCustomAdvanced": 1,
    "VAEDecode": 1,
    "VAEDecodeAudio": 1,
    "CreateVideo": 1,
    "SaveVideo": 1,
}
OPTIONAL_NODE_COUNTS = {"LoadImage": (0, 1)}
ALLOWED_NODE_CLASSES = frozenset(ALLOWED_NODE_COUNTS | OPTIONAL_NODE_COUNTS)
ALLOWED_MODELS = {
    "unet": frozenset({"minimax_h3_fl2va_int8_convrot.safetensors"}),
    "clip": frozenset(
        {"qwen3vl_32b_minimax_h3_int8_convrot.safetensors"}
    ),
    "vae": frozenset(
        {
            "minimax_h3_video_vae_fp16.safetensors",
            "minimax_h3_audio_vae_fp32.safetensors",
        }
    ),
    "pdd_acc": frozenset({"MiniMax-H3-FL2VA-Acc-8Step.safetensors"}),
}
INPUT_SUBFOLDER = "crowdmovie"
FIRST_FRAME_MAX_BYTES = 6_000_000
REQUEST_MAX_BYTES = 8_000_000
I2VA_HEADER = (
    "For the target video, at 0.00 seconds into the target video, <Picture 1> "
    "(from [Shot 1]) is fully referenced."
)
H3_BODY_PREFIX = "summary:\n"
H3_REQUIRED_FIELDS = (
    "summary:\n",
    "\n\ndetailed_description:\n",
    "\n\noverall_soundscape:\n",
    "\n\nnon_diegetic_music:\n",
)
H3_QUALITY_PHRASES = (
    "stabilized medium-wide gameplay camera",
    "sharp and readable",
    "no full-frame motion blur",
    "no depth-of-field blur",
    "no fog wash",
    "no camera shake",
)
NODE_ID_RE = re.compile(r"^[1-9][0-9]{0,3}$")
ROUND_ID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
OUTPUT_PREFIX_RE = re.compile(
    r"^video/FastH3/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-"
    r"[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

JOBS: dict[str, dict] = {}
IDEMPOTENCY: dict[str, str] = {}


class WorkflowValidationError(ValueError):
    """A stable, machine-readable rejection returned as structured HTTP 400."""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.details = details or {}


class GatewayBusyError(RuntimeError):
    pass


def reject(code: str, message: str, **details: object) -> None:
    raise WorkflowValidationError(code, message, details)


def duration_to_length(duration_seconds: int | float) -> int:
    requested_frames = max(5, round(float(duration_seconds) * FPS))
    return min(345, requested_frames + (5 - requested_frames % 17) % 17)


def capabilities_document() -> dict:
    film_enabled = os.environ.get("FASTH3_FILM_PLAN_ENABLED", "true").lower() == "true"
    return {
        "version": CAPABILITIES_VERSION if film_enabled else LEGACY_CAPABILITIES_VERSION,
        "engine": "minimax-h3-fl2va-pdd-acc-8nfe-full-int8-convrot",
        "comfyui_version": "0.34.0",
        "fps": FPS,
        "prompt_max_english_words": FILM_PROMPT_MAX_ENGLISH_WORDS if film_enabled else H3_PROMPT_MAX_ENGLISH_WORDS,
        "duration_seconds": {
            "minimum": MIN_DURATION_SECONDS,
            "maximum": MAX_DURATION_SECONDS,
            "length_formula": "round(duration_seconds*24) padded upward to length % 17 == 5, capped at 345 frames so output stays below 15 seconds",
        },
        "execution_backend": {
            "role": "ComfyUI sampling execution",
            "port": 8188,
        },
        "guard_gateway": {
            "role": "controlled workflow validation and dispatch",
            "port": PORT,
        },
        "sizes": [list(size) for size in sorted(ALLOWED_SIZES)],
        "node_classes": sorted(ALLOWED_NODE_CLASSES),
        "models": {key: sorted(values) for key, values in ALLOWED_MODELS.items()},
        "fixed_parameters": {
            "steps": 8,
            "nfe": "8",
            "sampler": "euler",
            "sigma_source": "MiniMaxH3PDDAccApply",
            "sigma_shift_video": 12.0,
            "sigma_shift_audio": 3.0,
            "guidance": 1.0,
            "fps": FPS,
            "output_format": "mp4",
            "output_codec": "auto",
        },
        "image_conditioning": {"first_frame": True, "last_frame": False},
        "motion_context": {"enabled": False},
        "external_loras": {"enabled": False},
        "style_profile": STYLE_PROFILE if film_enabled else "whos-next-spiderman-batman-quality-reference-v8",
        "style_enforced": True,
        "character_profile": CHARACTER_PROFILE,
        "character_enforced": True,
    }


def nodes_with_class(prompt: dict, class_type: str) -> list[tuple[str, dict]]:
    return [
        (node_id, node)
        for node_id, node in prompt.items()
        if node.get("class_type") == class_type
    ]


def only_node(prompt: dict, class_type: str) -> tuple[str, dict]:
    found = nodes_with_class(prompt, class_type)
    if len(found) != 1:
        reject(
            "node_count_mismatch",
            f"{class_type} must appear exactly once",
            class_type=class_type,
            count=len(found),
        )
    return found[0]


def validate_node_links(prompt: dict) -> None:
    for node_id, node in prompt.items():
        for input_name, value in node["inputs"].items():
            if (
                isinstance(value, list)
                and len(value) == 2
                and isinstance(value[0], str)
                and isinstance(value[1], int)
            ):
                if value[0] not in prompt or value[1] < 0:
                    reject(
                        "node_link_invalid",
                        f"node {node_id} input {input_name} has an invalid link",
                        node_id=node_id,
                        input=input_name,
                    )


def parse_first_frame(value: object, width: int, height: int) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        reject("first_frame_invalid", "first_frame must be an object")
    if set(value) != {"sha256", "png_base64"}:
        reject("first_frame_invalid", "first_frame fields must be sha256 and png_base64")
    declared = value.get("sha256")
    encoded = value.get("png_base64")
    if not isinstance(declared, str) or not re.fullmatch(r"[0-9a-f]{64}", declared):
        reject("first_frame_invalid", "first_frame.sha256 must be lowercase hex")
    if not isinstance(encoded, str):
        reject("first_frame_invalid", "first_frame.png_base64 must be a string")
    try:
        png = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error):
        reject("first_frame_invalid", "first_frame.png_base64 is invalid")
    if len(png) > FIRST_FRAME_MAX_BYTES or len(png) < 24:
        reject("first_frame_invalid", "first frame exceeds size limit or is truncated")
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        reject("first_frame_invalid", "first frame is not a PNG")
    png_width = int.from_bytes(png[16:20], "big")
    png_height = int.from_bytes(png[20:24], "big")
    if (png_width, png_height) != (width, height):
        reject("first_frame_invalid", "first frame dimensions do not match expected")
    if hashlib.sha256(png).hexdigest() != declared:
        reject("first_frame_hash_mismatch", "first frame sha256 does not match its bytes")
    return {"sha256": declared, "png": png}


def validate_workflow_envelope(payload: dict) -> dict:
    """Validate one of the two server-compiled v5 workflow shapes."""

    if not isinstance(payload, dict):
        reject("invalid_envelope", "request body must be a JSON object")
    if "motion_context" in payload:
        reject("motion_context_disabled", "Motion Context is disabled")
    if "combat_lora_enabled" in payload:
        reject("external_lora_disabled", "external LoRA selection is disabled")

    round_id = payload.get("round_id")
    if not isinstance(round_id, str) or not ROUND_ID_RE.fullmatch(round_id):
        reject("round_id_invalid", "round_id must be a UUID")
    idempotency_key = payload.get("idempotency_key")
    expected_key = f"h3:{round_id}:v1"
    if idempotency_key != expected_key:
        reject("idempotency_key_invalid", "idempotency_key must be canonical", expected=expected_key)
    if payload.get("capabilities_version") not in (CAPABILITIES_VERSION, LEGACY_CAPABILITIES_VERSION):
        reject(
            "capabilities_version_mismatch",
            "workflow was authored for a different capability set",
            expected=CAPABILITIES_VERSION,
            received=payload.get("capabilities_version"),
        )

    expected = payload.get("expected")
    if not isinstance(expected, dict):
        reject("expected_invalid", "expected must be an object")
    width = expected.get("width")
    height = expected.get("height")
    duration = expected.get("duration_seconds")
    fps = expected.get("fps")
    if not isinstance(width, int) or not isinstance(height, int):
        reject("dimensions_invalid", "expected width and height must be integers")
    if (width, height) not in ALLOWED_SIZES:
        reject("dimensions_not_allowed", f"unsupported size {width}x{height}")
    if (
        not isinstance(duration, (int, float))
        or isinstance(duration, bool)
        or duration < MIN_DURATION_SECONDS
        or duration > MAX_DURATION_SECONDS
    ):
        reject("duration_not_allowed", "duration_seconds must be between 5 and 15")
    if fps != FPS:
        reject("fps_mismatch", f"fps must be {FPS}", expected=FPS, received=fps)

    prompt = payload.get("prompt")
    if not isinstance(prompt, dict) or not prompt or len(prompt) > 16:
        reject("prompt_invalid", "prompt must contain 1-16 workflow nodes")
    normalized_prompt = copy.deepcopy(prompt)
    first_frame = parse_first_frame(payload.get("first_frame"), width, height)

    counts = {class_type: 0 for class_type in ALLOWED_NODE_CLASSES}
    for node_id, node in normalized_prompt.items():
        if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
            reject("node_id_invalid", "node ids must be short positive integers")
        if not isinstance(node, dict):
            reject("node_invalid", f"node {node_id} must be an object")
        class_type = node.get("class_type")
        if class_type not in ALLOWED_NODE_CLASSES:
            reject(
                "node_class_not_allowed",
                f"node {node_id} uses a non-allowlisted class",
                node_id=node_id,
                class_type=class_type,
            )
        if not isinstance(node.get("inputs"), dict):
            reject("node_inputs_invalid", f"node {node_id} inputs must be an object")
        counts[class_type] += 1
        if "last_frame" in node["inputs"]:
            reject("last_frame_disabled", "target last-frame conditioning is disabled")

    for class_type, required_count in ALLOWED_NODE_COUNTS.items():
        if counts[class_type] != required_count:
            reject(
                "node_count_mismatch",
                f"{class_type} must appear {required_count} time(s)",
                class_type=class_type,
                expected=required_count,
                received=counts[class_type],
            )
    for class_type, (minimum, maximum) in OPTIONAL_NODE_COUNTS.items():
        if not minimum <= counts[class_type] <= maximum:
            reject("node_count_mismatch", f"{class_type} count is outside its optional range")

    h3_id, h3 = only_node(normalized_prompt, "MiniMaxH3ImageToVideo")
    load_images = nodes_with_class(normalized_prompt, "LoadImage")
    has_first_frame_link = "first_frame" in h3["inputs"]
    graph_is_i2va = len(load_images) == 1 and has_first_frame_link
    if graph_is_i2va and first_frame is None:
        reject("first_frame_missing", "I2VA graph requires the verified first_frame envelope")
    if first_frame is not None and not graph_is_i2va:
        reject("first_frame_unexpected", "first_frame payload requires the I2VA graph")
    if len(load_images) != (1 if graph_is_i2va else 0) or has_first_frame_link != graph_is_i2va:
        reject("first_frame_invalid", "LoadImage and first_frame link must appear together")
    validate_node_links(normalized_prompt)

    unet_id, unet = only_node(normalized_prompt, "UNETLoader")
    if unet["inputs"] != {
        "unet_name": "minimax_h3_fl2va_int8_convrot.safetensors",
        "weight_dtype": "default",
    }:
        if unet["inputs"].get("unet_name") not in ALLOWED_MODELS["unet"]:
            reject("model_not_allowed", "UNET checkpoint is not allowlisted")
        reject("pdd_graph_invalid", "UNETLoader inputs do not match the pinned graph")

    clip_id, clip = only_node(normalized_prompt, "CLIPLoader")
    expected_clip = {
        "clip_name": "qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
        "type": "minimax",
        "device": "default",
    }
    if clip["inputs"] != expected_clip:
        if clip["inputs"].get("clip_name") not in ALLOWED_MODELS["clip"]:
            reject("model_not_allowed", "text encoder is not allowlisted")
        reject("clip_type_not_allowed", "CLIPLoader must match the pinned text encoder")

    vaes = nodes_with_class(normalized_prompt, "VAELoader")
    vae_names = {node["inputs"].get("vae_name") for _, node in vaes}
    if vae_names != set(ALLOWED_MODELS["vae"]):
        reject("model_not_allowed", "video/audio VAE set does not match the allowlist")
    video_vae_id = next(node_id for node_id, node in vaes if node["inputs"].get("vae_name") == "minimax_h3_video_vae_fp16.safetensors")
    audio_vae_id = next(node_id for node_id, node in vaes if node["inputs"].get("vae_name") == "minimax_h3_audio_vae_fp32.safetensors")

    shift_id, shift = only_node(normalized_prompt, "MiniMaxH3SigmaShift")
    if shift["inputs"] != {"model": [unet_id, 0], "shift_video": 12.0, "shift_audio": 3.0}:
        reject("pdd_graph_invalid", "MiniMaxH3SigmaShift inputs do not match the pinned graph")

    pdd_id, pdd = only_node(normalized_prompt, "MiniMaxH3PDDAccApply")
    expected_pdd = {
        "model": [shift_id, 0],
        "pdd_file": "MiniMax-H3-FL2VA-Acc-8Step.safetensors",
        "nfe": "8",
        "lora_strength": 1.0,
        "head_strength": 1.0,
        "on_off_grid": "error",
        "partition": "",
        "enabled": True,
    }
    if pdd["inputs"] != expected_pdd:
        reject("pdd_graph_invalid", "PDD NFE8 inputs do not match the pinned runtime node")

    scene_prompt = h3["inputs"].get("prompt")
    if not isinstance(scene_prompt, str) or not scene_prompt.strip():
        reject("scene_prompt_invalid", "MiniMax H3 prompt must be non-empty")
    word_limit = FILM_PROMPT_MAX_ENGLISH_WORDS if payload.get("capabilities_version") == CAPABILITIES_VERSION else H3_PROMPT_MAX_ENGLISH_WORDS
    if (
        len(scene_prompt) > H3_PROMPT_MAX_CHARACTERS
        or len(ENGLISH_WORD_RE.findall(scene_prompt)) > word_limit
    ):
        reject("scene_prompt_too_long", f"MiniMax H3 prompt exceeds {word_limit} English words")
    if FORBIDDEN_CAMERA_MOTION_RE.search(scene_prompt):
        reject("scene_prompt_camera_blur_risk", "prompt camera motion risks full-frame blur")
    if (h3["inputs"].get("width"), h3["inputs"].get("height")) != (width, height):
        reject("dimensions_mismatch", "workflow dimensions do not match expected")
    required_length = duration_to_length(duration)
    if h3["inputs"].get("length") != required_length:
        reject(
            "length_mismatch",
            "workflow length does not match expected duration",
            expected=required_length,
            received=h3["inputs"].get("length"),
        )
    expected_h3_keys = {"clip", "vae", "prompt", "width", "height", "length"}
    if graph_is_i2va:
        expected_h3_keys.add("first_frame")
    if (
        set(h3["inputs"]) != expected_h3_keys
        or h3["inputs"].get("clip") != [clip_id, 0]
        or h3["inputs"].get("vae") != [video_vae_id, 0]
    ):
        reject("pdd_graph_invalid", "MiniMaxH3ImageToVideo inputs do not match the pinned graph")

    if graph_is_i2va:
        load_id, load = load_images[0]
        if load["inputs"] != {"image": f"{INPUT_SUBFOLDER}/{round_id}.png"}:
            reject("first_frame_invalid", "LoadImage path must match the round")
        if h3["inputs"].get("first_frame") != [load_id, 0]:
            reject("first_frame_invalid", "MiniMaxH3ImageToVideo first_frame link is invalid")
        body = scene_prompt[len(I2VA_HEADER) + 2:] if scene_prompt.startswith(f"{I2VA_HEADER}\n\n") else ""
        if (
            not body.startswith((H3_BODY_PREFIX, "integrated_multimodal_description:\n") if payload["capabilities_version"] == CAPABILITIES_VERSION else H3_BODY_PREFIX)
            or "opens exactly on <Picture 1>" not in body
            or "action continues without a pause" not in body.lower()
        ):
            reject("scene_prompt_mode_invalid", "I2VA prompt must use and develop from Picture 1")
    elif not scene_prompt.startswith((H3_BODY_PREFIX, "integrated_multimodal_description:\n") if payload["capabilities_version"] == CAPABILITIES_VERSION else H3_BODY_PREFIX) or "<Picture" in scene_prompt:
        reject("scene_prompt_mode_invalid", "T2VA prompt must use the core fields without Picture inputs")

    sampler_id, sampler = only_node(normalized_prompt, "KSamplerSelect")
    if sampler["inputs"] != {"sampler_name": "euler"}:
        reject("sampler_not_allowed", "PDD workflow sampler must be euler")
    noise_id, noise = only_node(normalized_prompt, "RandomNoise")
    seed = noise["inputs"].get("noise_seed")
    if set(noise["inputs"]) != {"noise_seed"} or not isinstance(seed, int) or isinstance(seed, bool) or seed < 0:
        reject("noise_invalid", "RandomNoise must use one non-negative integer seed")
    guider_id, guider = only_node(normalized_prompt, "BasicGuider")
    if guider["inputs"] != {"model": [pdd_id, 0], "conditioning": [h3_id, 0]}:
        reject("pdd_graph_invalid", "BasicGuider must use the PDD model directly")
    advanced_id, advanced = only_node(normalized_prompt, "SamplerCustomAdvanced")
    if advanced["inputs"] != {
        "noise": [noise_id, 0],
        "guider": [guider_id, 0],
        "sampler": [sampler_id, 0],
        "sigmas": [pdd_id, 1],
        "latent_image": [h3_id, 1],
    }:
        reject("pdd_graph_invalid", "SamplerCustomAdvanced links do not match the pinned graph")

    video_decode_id, video_decode = only_node(normalized_prompt, "VAEDecode")
    audio_decode_id, audio_decode = only_node(normalized_prompt, "VAEDecodeAudio")
    if video_decode["inputs"] != {"samples": [advanced_id, 0], "vae": [video_vae_id, 0]}:
        reject("pdd_graph_invalid", "VAEDecode links do not match the pinned graph")
    if audio_decode["inputs"] != {"samples": [advanced_id, 0], "vae": [audio_vae_id, 0]}:
        reject("pdd_graph_invalid", "VAEDecodeAudio links do not match the pinned graph")
    video_id, video = only_node(normalized_prompt, "CreateVideo")
    if video["inputs"].get("fps") != FPS:
        reject("fps_mismatch", f"CreateVideo fps must be {FPS}")
    if video["inputs"] != {"images": [video_decode_id, 0], "audio": [audio_decode_id, 0], "fps": FPS}:
        reject("pdd_graph_invalid", "CreateVideo links do not match the pinned graph")

    _, output = only_node(normalized_prompt, "SaveVideo")
    output_inputs = output["inputs"]
    prefix = output_inputs.get("filename_prefix")
    if not isinstance(prefix, str) or not OUTPUT_PREFIX_RE.fullmatch(prefix):
        reject("output_path_not_allowed", "SaveVideo output must be video/FastH3/<round UUID>")
    if prefix != f"video/FastH3/{round_id}":
        reject("output_path_not_allowed", "SaveVideo output must match round_id")
    if output_inputs != {
        "video": [video_id, 0],
        "filename_prefix": prefix,
        "format": "mp4",
        "codec": "auto",
    }:
        reject("pdd_graph_invalid", "SaveVideo links do not match the pinned graph")

    h3["inputs"]["prompt"] = enforce_film_style(scene_prompt, duration) if payload["capabilities_version"] == CAPABILITIES_VERSION else enforce_fixed_style(scene_prompt)
    return {
        "round_id": round_id,
        "idempotency_key": idempotency_key,
        "capabilities_version": payload["capabilities_version"],
        "expected": {
            "width": width,
            "height": height,
            "duration_seconds": float(duration),
            "fps": FPS,
        },
        "prompt": normalized_prompt,
        "first_frame": first_frame,
        "image_conditioned": first_frame is not None,
    }


def validate_workflow_only(payload: dict) -> dict:
    """Run the exact submission guard without creating a job or touching GPU state."""

    normalized = validate_workflow_envelope(payload)
    return {
        "valid": True,
        "round_id": normalized["round_id"],
        "capabilities_version": normalized["capabilities_version"],
        "node_count": len(normalized["prompt"]),
        "image_conditioned": normalized["image_conditioned"],
        "style_enforced": True,
        "character_enforced": True,
        "generation_submitted": False,
    }


def get_json(url: str, timeout: float = 5.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def wait_json(url: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            return get_json(url)
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
            last_error = error
            time.sleep(1)
    raise TimeoutError(f"timed out waiting for {url}: {last_error}")


def post_json(url: str, payload: dict, timeout: float = 30.0) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def post_multipart(
    url: str,
    fields: dict[str, str],
    file_field: str,
    filename: str,
    content: bytes,
    timeout: float = 30.0,
) -> dict:
    boundary = f"----CrowdMovie{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )
    parts.append(
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\nContent-Type: image/png\r\n\r\n".encode()
        + content
        + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    request = urllib.request.Request(
        url,
        data=b"".join(parts),
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def upload_first_frame(round_id: str, first_frame: dict) -> None:
    filename = f"{round_id}.png"
    response = post_multipart(
        f"{COMFY_URL}/upload/image",
        {"subfolder": INPUT_SUBFOLDER, "type": "input", "overwrite": "true"},
        "image",
        filename,
        first_frame["png"],
    )
    if response.get("name") != filename or response.get("subfolder") != INPUT_SUBFOLDER:
        raise RuntimeError("ComfyUI returned an unexpected first-frame upload path")


def check_comfy_queue() -> None:
    wait_json(f"{COMFY_URL}/system_stats", 10)
    queue = get_json(f"{COMFY_URL}/queue")
    if queue.get("queue_running") or queue.get("queue_pending"):
        raise RuntimeError("comfyui_queue_not_empty")


def enforce_film_style(scene_prompt: str, duration: float) -> str:
    body = scene_prompt.removeprefix(f"{I2VA_HEADER}\n\n")
    fields = H3_REQUIRED_FIELDS if body.startswith(H3_BODY_PREFIX) else (
        "integrated_multimodal_description:\n", "\n\noverall_soundscape:\n", "\n\nnon_diegetic_music:\n")
    positions = [body.find(field) for field in fields]
    if positions[0] != 0 or positions != sorted(positions) or any(p < 0 for p in positions):
        reject("scene_prompt_invalid", "film prompt fields are missing or out of order")
    body_without_header = body
    shots = [int(value) for value in re.findall(r"\[Shot (\d+)\]", body_without_header)]
    if not 1 <= len(shots) <= 3 or shots != list(range(1, len(shots) + 1)):
        reject("scene_prompt_shots_invalid", "film prompt requires 1-3 ordered shots")
    cuts = [int(m) * 60 + float(s) for m, s in re.findall(r"At (\d{2}):(\d{2}\.\d{3}), the camera cuts", body)]
    boundaries = [0.0, *cuts, float(duration)]
    if len(cuts) != len(shots) - 1 or any(b - a < 1.5 for a, b in zip(boundaries, boundaries[1:])):
        reject("scene_prompt_cuts_invalid", "film cut times must match shots and fit duration")
    for phrase in ("sharp and readable", "no full-frame motion blur", "no fog wash", "no camera shake"):
        if phrase not in body.lower():
            reject("scene_prompt_style_invalid", "film prompt omits spatial clarity constraint", missing=phrase)
    # Validation never adds camera instructions or rewrites accepted choreography.
    return scene_prompt


def enforce_fixed_style(scene_prompt: str) -> str:
    prompt = scene_prompt.strip()
    if prompt.startswith(f"{I2VA_HEADER}\n\n"):
        prompt = prompt[len(I2VA_HEADER) + 2:]
    positions = [prompt.find(field) for field in H3_REQUIRED_FIELDS]
    if positions[0] != 0 or positions != sorted(positions) or any(position < 0 for position in positions):
        reject("scene_prompt_invalid", "H3 prompt body must start with the official first field")
    lowered = prompt.lower()
    missing = [phrase for phrase in H3_QUALITY_PHRASES if phrase not in lowered]
    if missing:
        reject(
            "scene_prompt_style_invalid",
            "prompt must match the v8 sharp-readable quality reference",
            missing=missing,
        )
    return scene_prompt.strip()


def build_workflow(payload: dict, job_id: str) -> tuple[dict, dict]:
    prompt = payload.get("prompt")
    if (
        not isinstance(prompt, str)
        or not prompt.strip()
        or len(prompt) > H3_PROMPT_MAX_CHARACTERS
        or len(ENGLISH_WORD_RE.findall(prompt)) > H3_PROMPT_MAX_ENGLISH_WORDS
    ):
        raise ValueError("prompt must contain at most 2000 English words")

    width = payload.get("width", 1344)
    height = payload.get("height", 768)
    if not isinstance(width, int) or not isinstance(height, int):
        raise ValueError("width and height must be integers")
    if (width, height) not in ALLOWED_SIZES:
        raise ValueError(f"unsupported size {width}x{height}")

    duration = payload.get("duration_seconds", 5)
    if not isinstance(duration, (int, float)) or isinstance(duration, bool):
        raise ValueError("duration_seconds must be numeric")
    duration = float(duration)
    if duration < 5 or duration > 15:
        raise ValueError("duration_seconds must be between 5 and 15")

    seed = payload.get("seed", 1000)
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 or seed > 2**64 - 1:
        raise ValueError("seed must be an unsigned 64-bit integer")

    length = duration_to_length(duration)
    workflow = copy.deepcopy(WORKFLOW)
    workflow["7"]["inputs"].update(
        prompt=enforce_fixed_style(prompt), width=width, height=height, length=length
    )
    workflow["10"]["inputs"]["noise_seed"] = seed
    workflow["15"]["inputs"]["filename_prefix"] = f"video/FastH3/{job_id}"
    normalized = {
        "job_id": job_id,
        "width": width,
        "height": height,
        "duration_seconds": duration,
        "length": length,
        "fps": 24,
        "seed": seed,
        "steps": 8,
        "sampler": "euler",
        "style_profile": STYLE_PROFILE,
        "style_enforced": True,
        "character_profile": CHARACTER_PROFILE,
        "character_enforced": True,
    }
    return workflow, normalized


def extract_outputs(history: dict, prompt_id: str) -> list[dict]:
    entry = history.get(prompt_id, {})
    status = entry.get("status", {})
    if status.get("status_str") == "error":
        messages = status.get("messages", [])
        raise RuntimeError(f"comfyui_execution_error: {messages[-1:]}")

    files: list[dict] = []
    for node_output in entry.get("outputs", {}).values():
        for key in ("videos", "images", "audio"):
            for item in node_output.get(key, []):
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                query = urllib.parse.urlencode(
                    {
                        "filename": item["filename"],
                        "subfolder": item.get("subfolder", ""),
                    }
                )
                files.append(
                    {
                        **item,
                        "download_url": f"{PUBLIC_BASE_URL}/v1/output?{query}",
                    }
                )
    return files


def public_job(job: dict) -> dict:
    return {
        key: copy.deepcopy(value)
        for key, value in job.items()
        if key not in {"idempotency_key", "round_id"}
    } | {
        "round_id": job["round_id"],
        "motion_context_id": None,
        "style_profile": STYLE_PROFILE,
        "style_enforced": True,
        "character_profile": CHARACTER_PROFILE,
        "character_enforced": True,
    }


def persist_jobs() -> None:
    """Persist compact job state so a gateway restart cannot duplicate a round."""

    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "jobs": list(JOBS.values())[-100:],
        "idempotency": IDEMPOTENCY,
    }
    temporary = STATE_PATH.with_name(f".{STATE_PATH.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    temporary.replace(STATE_PATH)


def load_jobs() -> None:
    if not STATE_PATH.is_file():
        return
    try:
        payload = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        for job in payload.get("jobs", []):
            if isinstance(job, dict) and isinstance(job.get("job_id"), str):
                JOBS[job["job_id"]] = job
        for key, job_id in payload.get("idempotency", {}).items():
            if isinstance(key, str) and job_id in JOBS:
                IDEMPOTENCY[key] = job_id
    except (OSError, json.JSONDecodeError, TypeError) as error:
        print(f"ignoring unreadable gateway state: {error!r}", flush=True)


def set_job_state(job_id: str, **changes: object) -> dict:
    with STATE_LOCK:
        job = JOBS[job_id]
        job.update(changes, updated_at=time.time())
        persist_jobs()
        return copy.deepcopy(job)


def monitor_workflow_job(job_id: str) -> None:
    job = JOBS[job_id]
    prompt_id = job["prompt_id"]
    started = time.monotonic()
    deadline = started + GENERATION_TIMEOUT_SECONDS
    try:
        while time.monotonic() < deadline:
            history = get_json(f"{COMFY_URL}/history/{prompt_id}", timeout=15)
            if prompt_id in history:
                outputs = extract_outputs(history, prompt_id)
                if not outputs:
                    raise RuntimeError("FastH3 completed without a downloadable output")
                set_job_state(
                    job_id,
                    status="completed",
                    elapsed_seconds=round(time.monotonic() - started, 3),
                    outputs=outputs,
                    error=None,
                )
                return
            time.sleep(2)
        raise TimeoutError(
            f"FastH3 generation exceeded {GENERATION_TIMEOUT_SECONDS:g} seconds"
        )
    except Exception as error:  # noqa: BLE001 - background job boundary
        print(f"workflow job {job_id} failed: {error!r}", flush=True)
        set_job_state(
            job_id,
            status="failed",
            elapsed_seconds=round(time.monotonic() - started, 3),
            error={"code": "generation_failed", "message": str(error)},
        )
    finally:
        if JOB_LOCK.locked():
            JOB_LOCK.release()


def submit_workflow(payload: dict) -> tuple[dict, bool]:
    normalized = validate_workflow_envelope(payload)
    idempotency_key = normalized["idempotency_key"]
    with STATE_LOCK:
        existing_id = IDEMPOTENCY.get(idempotency_key)
        if existing_id is not None and existing_id in JOBS:
            return public_job(JOBS[existing_id]), True

    if not JOB_LOCK.acquire(blocking=False):
        raise GatewayBusyError("fasth3_busy")
    try:
        check_comfy_queue()
        if normalized["first_frame"] is not None:
            try:
                upload_first_frame(normalized["round_id"], normalized["first_frame"])
            except Exception as error:
                raise WorkflowValidationError(
                    "first_frame_upload_failed",
                    f"could not upload the previous end frame: {error}",
                ) from error
        job_id = uuid.uuid4().hex
        response = post_json(
            f"{COMFY_URL}/prompt",
            {
                "prompt": normalized["prompt"],
                "client_id": f"crowdmovie-{job_id}",
            },
        )
        prompt_id = response["prompt_id"]
        job = {
            "job_id": job_id,
            "round_id": normalized["round_id"],
            "idempotency_key": idempotency_key,
            "prompt_id": prompt_id,
            "status": "running",
            "capabilities_version": normalized["capabilities_version"],
            "motion_context_id": None,
            "image_conditioned": normalized["image_conditioned"],
            "expected": normalized["expected"],
            "created_at": time.time(),
            "updated_at": time.time(),
            "elapsed_seconds": None,
            "outputs": [],
            "error": None,
        }
        with STATE_LOCK:
            JOBS[job_id] = job
            IDEMPOTENCY[idempotency_key] = job_id
            persist_jobs()
        thread = threading.Thread(
            target=monitor_workflow_job,
            args=(job_id,),
            name=f"fasth3-{job_id[:8]}",
            daemon=True,
        )
        thread.start()
        return public_job(job), False
    except Exception:
        JOB_LOCK.release()
        raise


def recover_jobs() -> None:
    """Resume polling the one in-flight ComfyUI prompt after a gateway restart."""

    load_jobs()
    active = [job for job in JOBS.values() if job.get("status") == "running"]
    if not active:
        return
    # The gateway has a single-job contract. If stale state somehow contains
    # more than one active row, fail all but the newest instead of guessing.
    active.sort(key=lambda job: job.get("updated_at", 0), reverse=True)
    current = active[0]
    for stale in active[1:]:
        set_job_state(
            stale["job_id"],
            status="failed",
            error={
                "code": "gateway_state_conflict",
                "message": "multiple active jobs found during recovery",
            },
        )
    if not JOB_LOCK.acquire(blocking=False):
        return
    thread = threading.Thread(
        target=monitor_workflow_job,
        args=(current["job_id"],),
        name=f"fasth3-recover-{current['job_id'][:8]}",
        daemon=True,
    )
    thread.start()


def run_generation(payload: dict) -> dict:
    job_id = uuid.uuid4().hex
    workflow, normalized = build_workflow(payload, job_id)
    check_comfy_queue()
    started = time.monotonic()
    response = post_json(
        f"{COMFY_URL}/prompt",
        {"prompt": workflow, "client_id": f"crowdmovie-{job_id}"},
    )
    prompt_id = response["prompt_id"]
    deadline = time.monotonic() + 1_800
    history: dict = {}
    while time.monotonic() < deadline:
        history = get_json(f"{COMFY_URL}/history/{prompt_id}", timeout=15)
        if prompt_id in history:
            break
        time.sleep(2)
    else:
        raise TimeoutError("FastH3 generation exceeded 1800 seconds")
    outputs = extract_outputs(history, prompt_id)
    if not outputs:
        raise RuntimeError("FastH3 completed without a downloadable output")
    return {
        **normalized,
        "prompt_id": prompt_id,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "outputs": outputs,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "CrowdMovieFastH3/2.0"

    def log_message(self, format_string: str, *args: object) -> None:
        print(f"{self.client_address[0]} {format_string % args}", flush=True)

    def allowed(self) -> bool:
        return self.client_address[0] in ALLOWED_CLIENTS

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(
        self,
        status: HTTPStatus,
        code: str,
        message: str,
        details: dict | None = None,
    ) -> None:
        self.send_json(
            status,
            {
                "error": {
                    "code": code,
                    "message": message,
                    "details": details or {},
                }
            },
        )

    def read_json_body(self) -> dict:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise WorkflowValidationError(
                "content_length_invalid", "Content-Length must be an integer"
            ) from error
        if content_length < 2 or content_length > REQUEST_MAX_BYTES:
            raise WorkflowValidationError(
                "request_size_invalid", f"request body must be 2-{REQUEST_MAX_BYTES} bytes"
            )
        try:
            payload = json.loads(self.rfile.read(content_length))
        except json.JSONDecodeError as error:
            raise WorkflowValidationError(
                "json_invalid", "request body is not valid JSON"
            ) from error
        if not isinstance(payload, dict):
            raise WorkflowValidationError(
                "invalid_envelope", "request body must be a JSON object"
            )
        return payload

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if not self.allowed():
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(
                HTTPStatus.OK,
                {
                    "status": "ok",
                    "busy": JOB_LOCK.locked(),
                    "comfyui_url": COMFY_URL,
                    "comfyui_ready": self.comfyui_ready(),
                    "style_profile": STYLE_PROFILE,
                    "style_enforced": True,
                    "character_profile": CHARACTER_PROFILE,
                    "character_enforced": True,
                },
            )
            return
        if parsed.path == "/v1/capabilities":
            self.send_json(HTTPStatus.OK, capabilities_document())
            return
        if parsed.path.startswith("/v1/jobs/"):
            job_id = parsed.path.removeprefix("/v1/jobs/")
            with STATE_LOCK:
                job = copy.deepcopy(JOBS.get(job_id))
            if job is None:
                self.send_error_json(
                    HTTPStatus.NOT_FOUND,
                    "job_not_found",
                    "the FastH3 job does not exist",
                )
                return
            self.send_json(HTTPStatus.OK, public_job(job))
            return
        if parsed.path == "/v1/output":
            self.serve_output(urllib.parse.parse_qs(parsed.query))
            return
        self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "route not found")

    @staticmethod
    def comfyui_ready() -> bool:
        try:
            get_json(f"{COMFY_URL}/system_stats", timeout=2)
            return True
        except (OSError, urllib.error.URLError, json.JSONDecodeError):
            return False

    def serve_output(self, query: dict[str, list[str]]) -> None:
        filename = query.get("filename", [""])[0]
        subfolder = query.get("subfolder", [""])[0]
        candidate = (OUTPUT_ROOT / subfolder / filename).resolve()
        if not filename or not candidate.is_relative_to(OUTPUT_ROOT) or not candidate.is_file():
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "output_not_found"})
            return
        mime_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        stat = candidate.stat()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime_type)
        self.send_header("Content-Length", str(stat.st_size))
        self.send_header("Content-Disposition", f'attachment; filename="{candidate.name}"')
        self.end_headers()
        with candidate.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                self.wfile.write(chunk)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if not self.allowed():
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return
        path = urllib.parse.urlparse(self.path).path
        if path not in {"/v1/t2va", "/v1/workflows", "/v1/workflows/validate"}:
            self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "route not found")
            return

        try:
            payload = self.read_json_body()
            if path == "/v1/workflows/validate":
                self.send_json(HTTPStatus.OK, validate_workflow_only(payload))
                return
            if path == "/v1/workflows":
                result, duplicate = submit_workflow(payload)
                self.send_json(
                    HTTPStatus.OK if duplicate else HTTPStatus.ACCEPTED,
                    result,
                )
                return

            if not JOB_LOCK.acquire(blocking=False):
                raise GatewayBusyError("fasth3_busy")
            try:
                result = run_generation(payload)
            finally:
                JOB_LOCK.release()
            self.send_json(HTTPStatus.OK, result)
        except WorkflowValidationError as error:
            self.send_error_json(
                HTTPStatus.BAD_REQUEST,
                error.code,
                error.message,
                error.details,
            )
        except GatewayBusyError:
            self.send_error_json(
                HTTPStatus.CONFLICT,
                "fasth3_busy",
                "another FastH3 job is already running",
            )
        except ValueError as error:
            self.send_error_json(
                HTTPStatus.BAD_REQUEST, "invalid_request", str(error)
            )
        except Exception as error:  # noqa: BLE001 - HTTP boundary
            print(f"generation failed: {error!r}", flush=True)
            if str(error) == "comfyui_queue_not_empty":
                self.send_error_json(
                    HTTPStatus.CONFLICT,
                    "comfyui_queue_not_empty",
                    "ComfyUI already has queued or running work",
                )
            else:
                self.send_error_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR,
                    "gateway_error",
                    str(error),
                )


with WORKFLOW_PATH.open("r", encoding="utf-8") as workflow_file:
    WORKFLOW = json.load(workflow_file)


if __name__ == "__main__":
    recover_jobs()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(
        f"FastH3 gateway listening on {HOST}:{PORT}; allowed clients={sorted(ALLOWED_CLIENTS)}",
        flush=True,
    )
    server.serve_forever()
