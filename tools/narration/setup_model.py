"""Download the audited upstream model revision once, never during playback."""
import os,hashlib,json
from pathlib import Path
from huggingface_hub import snapshot_download
home=Path(os.environ.get('NARRATION_HOME',Path.home()/'.cache'/'sonora'))
model=home/'narration-model'
revision='f3ff3571791e39611d31c381e3a41a3af07b4987'
files=['config.json','kokoro-v1_0.pth','voices/af_heart.pt','voices/af_bella.pt']
snapshot_download('hexgrad/Kokoro-82M',revision=revision,local_dir=model,allow_patterns=files,token=False)
hashes={name:hashlib.sha256((model/name).read_bytes()).hexdigest() for name in files}
if hashes['kokoro-v1_0.pth']!='496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4':
    raise RuntimeError('Model checksum differs from the upstream release.')
(model/'installation.json').write_text(json.dumps({'repository':'hexgrad/Kokoro-82M','revision':revision,'sha256':hashes},indent=2))
print('Pinned local model verified:',model)
