import base64
import copy
import hashlib
import importlib.util
import os
import re
import struct
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
os.environ.setdefault("FASTH3_WORKFLOW_PATH", str(HERE / "workflow_api.json"))

SPEC = importlib.util.spec_from_file_location(
    "fasth3_gateway", HERE / "fasth3_gateway.py"
)
gateway = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(gateway)


ROUND_ID = "11111111-1111-4111-8111-111111111111"
T2VA_PROMPT = (
    "summary:\nSpider-Man and Batman collide inside a crisp high-detail 3D fighting-game arena.\n\n"
    "detailed_description:\nA stabilized medium-wide gameplay camera tracks slowly sideways while "
    "keeping the entire rain-slick rooftop arena sharp and readable: brick parapets, steel vents, "
    "wet tile seams, antenna towers, distant skyscrapers and storm clouds remain in clear focus. "
    "Spider-Man launches a flying kick and Batman blocks with his armored forearm. Fast character "
    "motion has only localized limb and cape streaks; no full-frame motion blur, no depth-of-field "
    "blur, no fog wash, no camera shake.\n\n"
    "overall_soundscape:\nRain, armored impact and boots scraping wet stone.\n\n"
    "non_diegetic_music:\nOriginal tense electronic percussion."
)
I2VA_HEADER = (
    "For the target video, at 0.00 seconds into the target video, <Picture 1> "
    "(from [Shot 1]) is fully referenced."
)
I2VA_PROMPT = (
    f"{I2VA_HEADER}\n\n"
    "summary:\nSpider-Man and Batman continue their rooftop clash in a crisp high-detail 3D arena.\n\n"
    "detailed_description:\nThe shot opens exactly on <Picture 1>, preserving its framing, lighting, "
    "costumes and positions, and the action continues without a pause as Batman counters. A stabilized "
    "medium-wide gameplay camera tracks slowly sideways while keeping the entire rain-slick rooftop "
    "arena sharp and readable. Fast character motion has only localized limb and cape streaks; no "
    "full-frame motion blur, no depth-of-field blur, no fog wash, no camera shake.\n\n"
    "overall_soundscape:\nThe prior impact carries across the cut.\n\n"
    "non_diegetic_music:\nOriginal tense percussion continues."
)


def png_1344x768():
    # The guard only needs a real PNG signature and IHDR dimensions. Upload is
    # separately mocked in unit tests; ComfyUI decodes the production PNG.
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">II", 1344, 768)
        + b"\x08\x02\x00\x00\x00"
        + b"\x00\x00\x00\x00"
        + b"IEND"
    )


def valid_envelope(duration_seconds=5):
    workflow = copy.deepcopy(gateway.WORKFLOW)
    workflow["7"]["inputs"].update(
        prompt=T2VA_PROMPT,
        width=1344,
        height=768,
        length=gateway.duration_to_length(duration_seconds),
    )
    workflow["15"]["inputs"]["filename_prefix"] = f"video/FastH3/{ROUND_ID}"
    return {
        "round_id": ROUND_ID,
        "idempotency_key": f"h3:{ROUND_ID}:v1",
        "capabilities_version": gateway.LEGACY_CAPABILITIES_VERSION,
        "expected": {
            "width": 1344,
            "height": 768,
            "duration_seconds": duration_seconds,
            "fps": 24,
        },
        "prompt": workflow,
    }


def tail_envelope(duration_seconds=8):
    envelope = valid_envelope(duration_seconds)
    png = png_1344x768()
    digest = hashlib.sha256(png).hexdigest()
    envelope["first_frame"] = {
        "sha256": digest,
        "png_base64": base64.b64encode(png).decode(),
    }
    envelope["prompt"]["16"] = {
        "class_type": "LoadImage",
        "inputs": {"image": f"crowdmovie/{ROUND_ID}.png"},
    }
    envelope["prompt"]["7"]["inputs"].update(
        prompt=I2VA_PROMPT,
        first_frame=["16", 0],
    )
    return envelope


class WorkflowValidationTest(unittest.TestCase):
    def test_v6_word_limit_is_8000_and_never_silently_truncates(self):
        envelope = valid_envelope(8)
        envelope['capabilities_version'] = gateway.CAPABILITIES_VERSION
        prompt = T2VA_PROMPT.replace('A stabilized medium-wide gameplay camera tracks slowly sideways', '[Shot 1] A fixed wide camera holds position')
        remaining = 8000 - len(gateway.ENGLISH_WORD_RE.findall(prompt))
        prompt += ' wet' * remaining
        envelope['prompt']['7']['inputs']['prompt'] = prompt
        normalized = gateway.validate_workflow_envelope(envelope)
        self.assertEqual(normalized['prompt']['7']['inputs']['prompt'], prompt)
        envelope['prompt']['7']['inputs']['prompt'] += ' wet'
        with self.assertRaisesRegex(gateway.WorkflowValidationError, 'scene_prompt_too_long'):
            gateway.validate_workflow_envelope(envelope)

    def test_v6_preserves_ordered_cuts_without_adding_legacy_camera(self):
        envelope = valid_envelope(8)
        envelope['capabilities_version'] = gateway.CAPABILITIES_VERSION
        text = T2VA_PROMPT.replace('A stabilized medium-wide gameplay camera tracks slowly sideways', '[Shot 1] A fixed wide camera holds position')
        text = text.replace('\n\noverall_soundscape:', '\n[Shot 2] At 00:04.000, the camera cuts to a medium view. Batman plants his boot.\n\noverall_soundscape:')
        envelope['prompt']['7']['inputs']['prompt'] = text
        normalized = gateway.validate_workflow_envelope(envelope)
        self.assertEqual(normalized['prompt']['7']['inputs']['prompt'], text)
        self.assertEqual(normalized['capabilities_version'], gateway.CAPABILITIES_VERSION)
        envelope['prompt']['7']['inputs']['prompt'] = text.replace('00:04.000', '00:08.000')
        with self.assertRaisesRegex(gateway.WorkflowValidationError, 'scene_prompt_cuts_invalid'):
            gateway.validate_workflow_envelope(envelope)

    def test_v6_rollout_can_advertise_legacy_without_rejecting_new_packages(self):
        from unittest.mock import patch
        with patch.dict(os.environ, {'FASTH3_FILM_PLAN_ENABLED': 'false'}):
            self.assertEqual(gateway.capabilities_document()['version'], gateway.LEGACY_CAPABILITIES_VERSION)
            self.assertEqual(gateway.capabilities_document()['style_profile'], 'whos-next-spiderman-batman-quality-reference-v8')

    def test_legacy_t2va_builder_uses_the_v5_length_contract(self):
        workflow, normalized = gateway.build_workflow(
            {
                "prompt": T2VA_PROMPT,
                "width": 1344,
                "height": 768,
                "duration_seconds": 5,
                "seed": 20260903,
            },
            "compat-canary",
        )
        self.assertEqual(workflow["7"]["inputs"]["length"], 124)
        self.assertEqual(normalized["length"], 124)
        self.assertEqual(normalized["steps"], 8)

    def test_capabilities_match_clean_full_int8_pdd8_tail_contract(self):
        capabilities = gateway.capabilities_document()
        self.assertEqual(capabilities["version"], "h3-capabilities-v6")
        self.assertEqual(capabilities["fps"], 24)
        self.assertEqual(capabilities["sizes"], [[1344, 768]])
        self.assertEqual(
            capabilities["style_profile"],
            "whos-next-causal-cg-v1",
        )
        self.assertEqual(capabilities["character_profile"], "whos-next-famous-cast-v3")
        self.assertEqual(
            capabilities["models"]["unet"],
            ["minimax_h3_fl2va_int8_convrot.safetensors"],
        )
        self.assertEqual(capabilities["fixed_parameters"]["steps"], 8)
        self.assertEqual(capabilities["fixed_parameters"]["nfe"], "8")
        self.assertEqual(
            capabilities["image_conditioning"],
            {"first_frame": True, "last_frame": False},
        )
        self.assertEqual(capabilities["motion_context"], {"enabled": False})
        self.assertEqual(capabilities["external_loras"], {"enabled": False})

    def test_stateless_workflow_preserves_the_validated_v8_quality_prompt(self):
        original = valid_envelope()
        normalized = gateway.validate_workflow_envelope(copy.deepcopy(original))
        prompt = normalized["prompt"]["7"]["inputs"]["prompt"]
        self.assertTrue(prompt.startswith(gateway.H3_BODY_PREFIX))
        self.assertEqual(prompt, T2VA_PROMPT)
        self.assertIn("stabilized medium-wide gameplay camera", prompt)
        self.assertIn("sharp and readable", prompt)
        self.assertIn("no full-frame motion blur", prompt)
        self.assertIn("no depth-of-field blur", prompt)
        self.assertIn("no fog wash", prompt)
        self.assertIn("no camera shake", prompt)
        self.assertNotIn("Elden Ring", prompt)
        self.assertNotIn("Soulslike", prompt)
        self.assertEqual(normalized["expected"], original["expected"] | {"duration_seconds": 5.0})

    def test_legacy_elden_only_prompt_is_rejected_by_the_v8_quality_guard(self):
        envelope = valid_envelope()
        envelope["prompt"]["7"]["inputs"]["prompt"] = (
            "summary:\nTwo fighters collide.\n\n"
            "detailed_description:\nElden Ring Soulslike action in a dark arena.\n\n"
            "overall_soundscape:\nHeavy impacts.\n\n"
            "non_diegetic_music:\nFast percussion."
        )
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "scene_prompt_style_invalid"):
            gateway.validate_workflow_envelope(envelope)

    def test_validation_does_not_create_a_job(self):
        before = copy.deepcopy(gateway.JOBS)
        result = gateway.validate_workflow_only(valid_envelope())
        self.assertEqual(
            result,
            {
                "valid": True,
                "round_id": ROUND_ID,
                "capabilities_version": gateway.LEGACY_CAPABILITIES_VERSION,
                "node_count": 15,
                "image_conditioned": False,
                "style_enforced": True,
                "character_enforced": True,
                "generation_submitted": False,
            },
        )
        self.assertEqual(gateway.JOBS, before)

    def test_tail_frame_i2va_validates_digest_dimensions_graph_and_prompt(self):
        normalized = gateway.validate_workflow_envelope(tail_envelope())
        self.assertTrue(normalized["image_conditioned"])
        self.assertEqual(normalized["first_frame"]["sha256"], hashlib.sha256(png_1344x768()).hexdigest())
        self.assertEqual(normalized["prompt"]["7"]["inputs"]["first_frame"], ["16", 0])
        self.assertTrue(normalized["prompt"]["7"]["inputs"]["prompt"].startswith(I2VA_HEADER))

    def test_tail_frame_is_all_or_nothing(self):
        missing_payload = tail_envelope()
        del missing_payload["first_frame"]
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "first_frame_missing"):
            gateway.validate_workflow_envelope(missing_payload)

        unexpected_payload = valid_envelope()
        unexpected_payload["first_frame"] = tail_envelope()["first_frame"]
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "first_frame_unexpected"):
            gateway.validate_workflow_envelope(unexpected_payload)

        wrong_hash = tail_envelope()
        wrong_hash["first_frame"]["sha256"] = "a" * 64
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "first_frame_hash_mismatch"):
            gateway.validate_workflow_envelope(wrong_hash)

    def test_prompt_mode_must_match_image_mode(self):
        t2va_picture = valid_envelope()
        t2va_picture["prompt"]["7"]["inputs"]["prompt"] = I2VA_PROMPT
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "scene_prompt_mode_invalid"):
            gateway.validate_workflow_envelope(t2va_picture)

        i2va_without_anchor = tail_envelope()
        i2va_without_anchor["prompt"]["7"]["inputs"]["prompt"] = T2VA_PROMPT
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "scene_prompt_mode_invalid"):
            gateway.validate_workflow_envelope(i2va_without_anchor)

    def test_lora_motion_context_and_target_last_frame_are_rejected(self):
        cases = [
            ("17", "LoraLoaderModelOnly", {"model": ["6", 0]}, "node_class_not_allowed"),
            ("17", "MiniMaxH3MotionContext", {"conditioning": ["7", 0]}, "node_class_not_allowed"),
        ]
        for node_id, class_type, inputs, error_code in cases:
            with self.subTest(class_type=class_type):
                envelope = valid_envelope()
                envelope["prompt"][node_id] = {"class_type": class_type, "inputs": inputs}
                with self.assertRaisesRegex(gateway.WorkflowValidationError, error_code):
                    gateway.validate_workflow_envelope(envelope)

        last_frame = valid_envelope()
        last_frame["prompt"]["7"]["inputs"]["last_frame"] = ["16", 0]
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "last_frame_disabled"):
            gateway.validate_workflow_envelope(last_frame)

    def test_expected_dimensions_duration_and_length_must_agree(self):
        envelope = valid_envelope()
        envelope["prompt"]["7"]["inputs"]["length"] += 1
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "length_mismatch"):
            gateway.validate_workflow_envelope(envelope)

        ceiling = valid_envelope(15)
        self.assertEqual(ceiling["prompt"]["7"]["inputs"]["length"], 345)
        gateway.validate_workflow_envelope(ceiling)

        envelope = valid_envelope()
        envelope["prompt"]["7"]["inputs"]["width"] = 864
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "dimensions_mismatch"):
            gateway.validate_workflow_envelope(envelope)

    def test_fixed_pdd8_parameters_cannot_be_overridden(self):
        cases = [
            ("6", "nfe", "4", "pdd_graph_invalid"),
            ("9", "sampler_name", "res_multistep", "sampler_not_allowed"),
            ("14", "fps", 30, "fps_mismatch"),
            ("11", "sigmas", ["5", 0], "pdd_graph_invalid"),
        ]
        for node_id, key, value, error_code in cases:
            with self.subTest(node=node_id, key=key):
                envelope = valid_envelope()
                envelope["prompt"][node_id]["inputs"][key] = value
                with self.assertRaisesRegex(gateway.WorkflowValidationError, error_code):
                    gateway.validate_workflow_envelope(envelope)

    def test_unapproved_model_and_output_path_are_rejected(self):
        envelope = valid_envelope()
        envelope["prompt"]["1"]["inputs"]["unet_name"] = "other.safetensors"
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "model_not_allowed"):
            gateway.validate_workflow_envelope(envelope)

        envelope = valid_envelope()
        envelope["prompt"]["15"]["inputs"]["filename_prefix"] = "../../escape"
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "output_path_not_allowed"):
            gateway.validate_workflow_envelope(envelope)

    def test_h3_prompt_limit_remains_2000_english_words(self):
        envelope = valid_envelope()
        envelope["prompt"]["7"]["inputs"]["prompt"] = (
            f"{gateway.H3_BODY_PREFIX}Elden Ring Soulslike "
            f"{'accelerates ' * 2001}\n\noverall_soundscape: Air."
            "\n\nnon_diegetic_music: Percussion."
        )
        with self.assertRaisesRegex(gateway.WorkflowValidationError, "scene_prompt_too_long"):
            gateway.validate_workflow_envelope(envelope)


if __name__ == "__main__":
    unittest.main()
