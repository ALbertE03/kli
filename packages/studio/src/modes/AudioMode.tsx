/**
 * KLI — Audio mode
 *
 * Text-to-speech and speech-to-text through the active provider.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Mic, PauseCircle, Speaker, Trash2, Upload } from 'lucide-react';
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Chip, Segmented, Textarea } from '@/components/ui';
import { ModelField } from '@/components/ModelField';
import { ApiError, synthesizeSpeech, transcribeAudio } from '@/lib/api';
import { createId, formatRelativeTime } from '@/lib/utils';
import { useActiveProvider, useStore } from '@/store';
import { resolveApiKey, useSecrets } from '@/store/secrets';
import type { AudioClip } from '@/types';

const VOICES = [
  { value: 'alloy', label: 'alloy — neutra' },
  { value: 'nova', label: 'nova — cálida' },
  { value: 'fable', label: 'fable — narrativa' },
  { value: 'echo', label: 'echo — grave' },
  { value: 'shimmer', label: 'shimmer — brillante' },
] as const;

const DEFAULT_VOICE = VOICES[0].value;

const FORMATS = ['mp3', 'wav'] as const;

export function AudioMode() {
  const provider = useActiveProvider();
  const keys = useSecrets((state) => state.keys);
  const apiKey = resolveApiKey(provider.id, keys);
  const model = useStore((state) => state.selectedModels.audio);
  const isStreaming = useStore((state) => state.isStreaming);
  const setStreaming = useStore((state) => state.setStreaming);
  const connectionStatus = useStore((state) => state.connectionStatus);

  const [text, setText] = useState('');
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);
  const [format, setFormat] = useState<(typeof FORMATS)[number]>('mp3');
  const [clips, setClips] = useState<AudioClip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [transcript, setTranscript] = useState('');
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Revoke object URLs when the component goes away.
  useEffect(
    () => () => {
      for (const clip of clips) URL.revokeObjectURL(clip.url);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const speak = useCallback(async () => {
    const value = text.trim();
    if (!value || !model || isStreaming || connectionStatus !== 'connected') return;
    setError(null);
    setStreaming(true);
    try {
      const blob = await synthesizeSpeech(provider, apiKey, model, value, { voice, format });
      const clip: AudioClip = {
        id: createId('audio'),
        url: URL.createObjectURL(blob),
        text: value,
        voice,
        model,
        createdAt: Date.now(),
      };
      setClips((current) => [clip, ...current].slice(0, 12));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `${cause.message} · revisa que el proveedor tenga un motor de voz configurado.`
          : 'Error inesperado al generar el audio',
      );
    } finally {
      setStreaming(false);
    }
  }, [text, model, isStreaming, connectionStatus, provider, apiKey, voice, format, setStreaming]);

  const transcribe = useCallback(
    async (blob: Blob) => {
      if (!model) {
        setError('Selecciona un modelo de transcripción.');
        return;
      }
      if (connectionStatus !== 'connected') {
        setError('Sin conexión con el proveedor: no se puede transcribir.');
        return;
      }
      setError(null);
      setStreaming(true);
      try {
        const text = await transcribeAudio(provider, apiKey, model, blob);
        setTranscript(text);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Error al transcribir');
      } finally {
        setStreaming(false);
      }
    },
    [model, provider, apiKey, connectionStatus, setStreaming],
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        for (const track of stream.getTracks()) track.stop();
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        setRecording(false);
        void transcribe(blob);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError('No se pudo acceder al micrófono. Revisa los permisos del navegador.');
    }
  }, [transcribe]);

  const copyTranscript = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  }, [transcript]);

  const removeClip = (id: string) => {
    setClips((current) => {
      const target = current.find((clip) => clip.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return current.filter((clip) => clip.id !== id);
    });
  };

  const offline = connectionStatus !== 'connected';

  return (
    <div className="grid flex-1 gap-4 lg:grid-cols-2">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Speaker className="h-4 w-4 text-primary" />
              Texto a voz
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Escribe lo que quieres que se diga…"
            />

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">Voz</p>
              <div className="flex flex-wrap gap-2">
                {VOICES.map((item) => (
                  <Chip key={item.value} active={voice === item.value} onClick={() => setVoice(item.value)}>
                    {item.label}
                  </Chip>
                ))}
              </div>
            </div>

            <Segmented
              options={FORMATS.map((value) => ({ value, label: value.toUpperCase() }))}
              value={format}
              onValueChange={setFormat}
            />

            <ModelField mode="audio" label="Modelo de voz" />

            <Button
              className="w-full"
              onClick={() => void speak()}
              loading={isStreaming}
              disabled={!text.trim() || !model || connectionStatus !== 'connected'}
            >
              Generar voz
            </Button>

            {error ? (
              <Alert variant="destructive" className="text-xs">
                {error}
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        {clips.length > 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Reproducciones</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {clips.map((clip) => (
                <div key={clip.id} className="space-y-1.5 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-muted-foreground">{clip.text}</span>
                    <Button size="icon" variant="ghost" title="Eliminar" onClick={() => removeClip(clip.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <audio controls src={clip.url} className="h-8 w-full" />
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                    <Badge variant="outline">{clip.voice}</Badge>
                    <span className="truncate">{clip.model}</span>
                    <span className="ml-auto shrink-0">{formatRelativeTime(clip.createdAt)}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4 text-primary" />
            Voz a texto
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ModelField mode="audio" label="Modelo de transcripción" />

          <div className="grid gap-2 sm:grid-cols-2">
            <Button variant="outline" disabled={!model || offline} onClick={() => fileInputRef.current?.click()}>
              <Upload className="h-4 w-4" />
              Subir audio
            </Button>
            {recording ? (
              <Button variant="destructive" onClick={() => recorderRef.current?.stop()}>
                <PauseCircle className="h-4 w-4" />
                Detener
              </Button>
            ) : (
              <Button variant="outline" disabled={!model || offline} onClick={() => void startRecording()}>
                <Mic className="h-4 w-4" />
                Grabar
              </Button>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                setAudioFile(file);
                void transcribe(file);
              }
              event.target.value = '';
            }}
          />

          {audioFile ? <p className="text-xs text-muted-foreground">Archivo: {audioFile.name}</p> : null}

          {transcript ? (
            <div className="space-y-2">
              <Textarea
                rows={6}
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                className="font-mono text-xs"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void copyTranscript()}>
                  <Copy className="h-3.5 w-3.5" />
                  {copied ? 'Copiado' : 'Copiar'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const blob = new Blob([transcript], { type: 'text/plain;charset=utf-8' });
                    const url = URL.createObjectURL(blob);
                    const anchor = document.createElement('a');
                    anchor.href = url;
                    anchor.download = 'transcripcion.txt';
                    anchor.click();
                    URL.revokeObjectURL(url);
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  Exportar
                </Button>
              </div>
            </div>
          ) : null}

          {!error && !transcript ? (
            <Alert className="text-xs">
              Sube un archivo de audio o graba desde el micrófono. La transcripción se edita aquí antes de copiarla al
              chat.
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}