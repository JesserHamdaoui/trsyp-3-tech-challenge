# Frame record schema

Each element of `Attempt.frames` is one frame record. The browser builds it
with `buildFrameRecord()` in `interface/src/lib/handFeatures.ts`, which is a
port of `cv-poc/features.py::build_frame_record`. Because the two match,
in-browser patient attempts line up with the idealized reference attempts
that were seeded earlier.

The engine does **not** validate this schema. Units are as follows:
pixel-space values (`*_px*`, `*_xy`) use the video's resolution, values ending
in `_norm` or `_normalized` are 0–1, and angles are in degrees.

## Frame with no hand detected

```json
{ "timestamp_ms": 123456, "frame_index": 42, "hand_detected": false }
```

## Frame with a hand detected

```jsonc
{
  "timestamp_ms": 123456,          // performance.now()-based, ms
  "frame_index": 42,               // increments every processed frame, including frames with no hand
  "hand_detected": true,
  "handedness": "Unknown",         // currently hardcoded by the piano page
  "handedness_confidence": 0.9,    // currently hardcoded by the piano page

  "joints": {                      // per finger
    "index": {
      "mcp_angle_deg": 170.2,      // full precision, not rounded
      "pip_angle_deg": 165.0,
      "dip_angle_deg": 172.4,
      "curl_normalized": 0.12
    },
    "thumb": { "mcp_angle_deg": ..., "ip_angle_deg": ..., "curl_normalized": ... }
    // middle, ring, pinky: same as index
  },

  "fingers": {                     // per finger, tip-based dynamics
    "index": {
      "curl_normalized": 0.12,
      "tip_velocity_px_s": 35.2,
      "tip_acceleration_px_s2": -120.4,
      "tip_jerk_px_s3": 900.1,
      "path_length_total_px": 512.3,      // cumulative over the attempt
      "movement_smoothness_score": 0.81,  // 1/(1+CV) of the last 5 velocities
      "movement_direction": "still",      // "closing" | "opening" | "still" (Δcurl > ±0.02)
      "finger_identity_confidence": 0.9,  // = handedness confidence
      "is_extended": true                 // curl < 0.35
    }
  },

  "relational": {
    "thumb_index_pinch_distance_norm": 0.42,     // / hand size
    "finger_spread_angles_deg": { "thumb_index": 35.1, "index_middle": 9.8, "middle_ring": 7.2, "ring_pinky": 11.0 },
    "most_curled_finger": "pinky",
    "least_curled_finger": "index",
    "curl_synchrony_score": 0.88,                // 1 - std(curls)
    "all_fingers_curled_together": false          // all > 0.5 or all < 0.5
  },

  "hand": {
    "wrist_position_xy": { "x": 320.0, "y": 410.5 },
    "hand_centroid_xy": { "x": 330.2, "y": 300.1 },
    "hand_position_normalized": { "x": 0.516, "y": 0.625 },
    "hand_size_px": 260.4,                        // 2 × |wrist → middle MCP|
    "palm_normal_vector": { "x": 0.01, "y": -0.1, "z": -0.99 },
    "hand_orientation": "palm_facing_camera",     // | "back_facing_camera" | "side"  (normal.z < -0.5 / > 0.5)
    "wrist_rotation_deg": -4.2,                   // angle of wrist→middle MCP from vertical
    "bounding_box_norm": { "x_min": 0.4, "y_min": 0.3, "x_max": 0.6, "y_max": 0.9 },
    "hand_velocity_px_s": 12.0,
    "grip_state": "open"                          // mean curl > 0.8 closed, < 0.2 open, else partial
  },

  "raw_landmarks": [ { "x": 0.5, "y": 0.6, "z": -0.01 } /* × 21, MediaPipe normalized */ ]
}
```

## How curl is computed

`curlNormalized(finger)` works in 2D pixel space on the finger's four
landmarks (MCP, PIP, DIP, tip):

```
straightness = |tip − MCP| / (|PIP−MCP| + |DIP−PIP| + |tip−DIP|)     // 1 = perfectly straight
curl         = clamp((1 − straightness) / (1 − floor[finger]), 0, 1)
```

`floor` is `CURL_STRAIGHTNESS_FLOOR`: **0.83** for the thumb and **0.35** for
the other fingers. The thumb's floor is higher because its CMC-driven motion
never folds as far as the hinge chain of the other fingers, so without the
higher floor a fully bent thumb would never reach a curl of 1.

## Landmark indices (MediaPipe)

| Finger | MCP | PIP/IP | DIP | Tip |
|---|---|---|---|---|
| thumb | 1 | 2 | 3 | 4 |
| index | 5 | 6 | 7 | 8 |
| middle | 9 | 10 | 11 | 12 |
| ring | 13 | 14 | 15 | 16 |
| pinky | 17 | 18 | 19 | 20 |

The wrist is landmark 0. Joint angles are the 3D angle at the middle landmark
of each triple. For the MCP angle, the triple is (wrist, MCP, PIP).
