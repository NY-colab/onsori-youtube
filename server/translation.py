"""Optional local Korean translation of generated English sound descriptions."""
from __future__ import annotations

MODEL_ID = "Helsinki-NLP/opus-mt-tc-big-en-ko"
REVISION = "ae8606b7b29a495f31ce679cee2007f536a3a5ce"
_tokenizer = None
_model = None


def translate_captions(captions: list[dict], update, cancel) -> list[dict]:
    """Return copies with text_ko; preserve the English original for review."""
    global _tokenizer, _model
    if not captions:
        return []
    from .pipeline import check_cancel
    import torch
    from transformers import MarianMTModel, MarianTokenizer
    check_cancel(cancel)
    torch.set_num_threads(6)
    if _model is None:
        update(.90, "한국어 소리 묘사 준비 중 · 첫 실행은 번역 모델을 내려받습니다")
        # SentencePiece's Windows native filename loader rejects Korean paths.
        # Read with Python's Unicode-aware filesystem API, then load model bytes.
        from pathlib import Path
        from unittest.mock import patch
        import sentencepiece
        import json
        from huggingface_hub import hf_hub_download
        def load_spm_bytes(path, kwargs):
            processor = sentencepiece.SentencePieceProcessor(**kwargs)
            processor.LoadFromSerializedProto(Path(path).read_bytes())
            return processor
        # The upstream conversion ships an incorrect shared vocab.json (issue
        # OPUS-MT-train#81). Reconstruct both exact vocabularies from the pinned
        # SentencePiece models; never change model weights or assign new IDs.
        source = hf_hub_download(MODEL_ID, "source.spm", revision=REVISION)
        target = hf_hub_download(MODEL_ID, "target.spm", revision=REVISION)
        from .pipeline import MODEL_DIR
        vocab_dir = MODEL_DIR / "translation-vocab" / REVISION
        vocab_dir.mkdir(parents=True, exist_ok=True)
        for name, path in (("source", source), ("target", target)):
            spm = load_spm_bytes(path, {})
            vocab = {spm.id_to_piece(i): i for i in range(spm.get_piece_size())}
            vocab["<pad>"] = 32000
            (vocab_dir / f"{name}.json").write_text(json.dumps(vocab, ensure_ascii=False), encoding="utf-8")
        with patch("transformers.models.marian.tokenization_marian.load_spm", load_spm_bytes):
            _tokenizer = MarianTokenizer(source_spm=source, target_spm=target,
                vocab=str(vocab_dir / "source.json"), target_vocab_file=str(vocab_dir / "target.json"),
                separate_vocabs=True, source_lang="en", target_lang="ko")
        if not callable(_tokenizer):
            raise ValueError("한국어 번역 토크나이저를 불러오지 못했습니다.")
        _model = MarianMTModel.from_pretrained(MODEL_ID, revision=REVISION, use_safetensors=True).eval()
    results = []
    for i in range(0, len(captions), 4):
        check_cancel(cancel)
        batch = captions[i:i+4]
        inputs = _tokenizer([str(c["text"]) for c in batch], return_tensors="pt", padding=True, truncation=True, max_length=256)
        with torch.inference_mode():
            tokens = _model.generate(**inputs, max_new_tokens=160, num_beams=4)
        korean = _tokenizer.batch_decode(tokens, skip_special_tokens=True)
        results.extend({**c, "text_ko": k.strip()} for c, k in zip(batch, korean))
        update(.90 + .06 * min((i+4)/len(captions), 1), "생성한 소리 묘사를 한국어로 번역 중")
    return results
