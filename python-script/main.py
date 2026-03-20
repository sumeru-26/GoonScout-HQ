import json
from pathlib import Path

import cv2


DATA_FILE = Path(__file__).with_name("data.json")
DETECTION_SCALE = 0.6
CAMERA_INDEX = 0


def canonical_json(value):
	return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def load_existing_entries(file_path):
	if not file_path.exists():
		return []

	with file_path.open("r", encoding="utf-8") as source:
		raw_text = source.read().strip()

	if not raw_text:
		return []

	try:
		data = json.loads(raw_text)
	except json.JSONDecodeError:
		print("Warning: data.json is not valid JSON. Starting with an empty list.")
		return []

	if not isinstance(data, list):
		print("Warning: data.json must contain a JSON list. Starting with an empty list.")
		return []

	return data


def save_entries(file_path, entries):
	with file_path.open("w", encoding="utf-8") as target:
		json.dump(entries, target, indent=2, ensure_ascii=False)


def get_detected_qr(frame, detector, scale):
	if scale != 1.0:
		scaled_frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
	else:
		scaled_frame = frame

	multi_result = detector.detectAndDecodeMulti(scaled_frame)

	detections = []
	if isinstance(multi_result, tuple):
		if len(multi_result) == 4:
			ok, decoded_info, points, _ = multi_result
			if ok and decoded_info:
				for index, text in enumerate(decoded_info):
					if text:
						point_set = points[index] if points is not None and len(points) > index else None
						if point_set is not None and scale != 1.0:
							point_set = point_set / scale
						detections.append((text, point_set))
		elif len(multi_result) == 3:
			decoded_info, points, _ = multi_result
			if decoded_info:
				for index, text in enumerate(decoded_info):
					if text:
						point_set = points[index] if points is not None and len(points) > index else None
						if point_set is not None and scale != 1.0:
							point_set = point_set / scale
						detections.append((text, point_set))

	if detections:
		return detections

	single_payload, points, _ = detector.detectAndDecode(scaled_frame)
	if points is not None and scale != 1.0:
		points = points / scale
	return [(single_payload, points)] if single_payload else []


def draw_qr_outline(frame, points, color):
	if points is None:
		return

	polygon = points.astype("int32").reshape((-1, 1, 2))
	cv2.polylines(frame, [polygon], isClosed=True, color=color, thickness=3)


def configure_capture(capture):
	capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
	capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
	capture.set(cv2.CAP_PROP_FPS, 30)
	capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)


def has_usable_frames(capture, sample_count=20):
	for _ in range(sample_count):
		success, frame = capture.read()
		if success and frame is not None and frame.size > 0 and frame.any():
			return True
	return False


def open_camera():
	backends = [
		("DirectShow", cv2.CAP_DSHOW),
		("Default", cv2.CAP_ANY),
	]

	for backend_name, backend in backends:
		capture = cv2.VideoCapture(CAMERA_INDEX, backend)
		if not capture.isOpened():
			capture.release()
			continue

		configure_capture(capture)
		if has_usable_frames(capture):
			print(f"Using camera backend: {backend_name}")
			return capture

		print(f"Camera backend {backend_name} returned unusable frames, trying fallback...")
		capture.release()

	# Final fallback: OpenCV default constructor path.
	capture = cv2.VideoCapture(CAMERA_INDEX)
	if not capture.isOpened():
		raise RuntimeError("Could not open camera.")

	configure_capture(capture)
	if not has_usable_frames(capture):
		capture.release()
		raise RuntimeError("Camera opened but only black/empty frames were received.")

	print("Using camera backend: OpenCV default")
	return capture


def main():
	entries = load_existing_entries(DATA_FILE)
	seen_payloads = {canonical_json(item) for item in entries}
	detected_in_session = set()

	capture = open_camera()

	detector = cv2.QRCodeDetector()

	print("Scanning for QR codes...")
	print("Press 'q' in the camera window to quit.")

	try:
		while True:
			success, frame = capture.read()
			if not success:
				print("Failed to read frame from camera.")
				break

			detected_qr = get_detected_qr(frame, detector, DETECTION_SCALE)

			for payload, points in detected_qr:
				payload = payload.strip()
				if not payload:
					continue

				try:
					parsed_json = json.loads(payload)
				except json.JSONDecodeError:
					draw_qr_outline(frame, points, (0, 255, 0))
					if payload not in detected_in_session:
						detected_in_session.add(payload)
						print("Ignored QR code: payload is not valid JSON.")
					continue

				normalized = canonical_json(parsed_json)
				is_new_payload = normalized not in seen_payloads
				outline_color = (0, 0, 255) if is_new_payload else (0, 255, 0)

				draw_qr_outline(frame, points, outline_color)

				if payload in detected_in_session:
					continue

				detected_in_session.add(payload)
				if normalized in seen_payloads:
					print("Ignored duplicate QR payload.")
					continue

				entries.append(parsed_json)
				seen_payloads.add(normalized)
				save_entries(DATA_FILE, entries)
				print("Added new JSON entry to data.json")

			cv2.imshow("QR Scanner", frame)
			if cv2.waitKey(1) & 0xFF == ord("q"):
				break
	finally:
		capture.release()
		cv2.destroyAllWindows()


if __name__ == "__main__":
	main()
