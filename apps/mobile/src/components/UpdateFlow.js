import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius, shadow, spacing } from '../theme';

const STEPS = ['检查', '下载', '待生效', '完成'];

const STAGE_INDEX = {
  checking: 0,
  downloading: 1,
  pending: 2,
  available: 1,
  idle: 3,
};

const STAGE_TEXT = {
  checking: '正在检查更新…',
  downloading: '正在下载更新…',
  pending: '已下载，下次冷启动生效',
  available: '发现新版本，可以下载',
  idle: '已是最新版本',
};

export default function UpdateFlow({
  stage = 'idle',
  progress = 0,
  message,
  onCheck,
  onApply,
  busy,
}) {
  const index = STAGE_INDEX[stage] ?? 3;
  const action =
    stage === 'pending'
      ? { label: '立即应用', onPress: onApply }
      : stage === 'available'
        ? { label: '立即更新', onPress: onCheck }
        : { label: '检查更新', onPress: onCheck };
  const disabled = busy || stage === 'checking' || stage === 'downloading';

  return (
    <View style={styles.card}>
      <Text style={styles.title}>更新状态</Text>

      <View style={styles.steps}>
        {STEPS.map((step, i) => {
          const done = i < index;
          const active = i === index;
          return (
            <React.Fragment key={step}>
              {i > 0 ? (
                <View style={[styles.line, done || active ? styles.lineOn : null]} />
              ) : null}
              <View style={styles.step}>
                <View
                  style={[
                    styles.dot,
                    done ? styles.dotDone : null,
                    active ? styles.dotActive : null,
                  ]}
                />
                <Text style={[styles.stepText, active ? styles.stepTextActive : null]}>
                  {step}
                </Text>
              </View>
            </React.Fragment>
          );
        })}
      </View>

      {stage === 'downloading' ? (
        <View style={styles.bar}>
          <View style={[styles.barFill, { width: `${Math.min(100, Math.max(0, progress))}%` }]} />
        </View>
      ) : null}

      <Text style={styles.desc}>{message || STAGE_TEXT[stage] || STAGE_TEXT.idle}</Text>

      <Pressable
        onPress={action.onPress}
        disabled={disabled}
        style={({ pressed }) => [
          styles.button,
          disabled && styles.buttonDisabled,
          pressed && !disabled && styles.buttonPressed,
        ]}
      >
        <Text style={styles.buttonText}>{disabled ? '处理中…' : action.label}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: spacing.card,
    marginBottom: spacing.gap,
    ...shadow,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text,
    marginBottom: 14,
  },
  steps: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  step: {
    alignItems: 'center',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.line,
  },
  dotDone: {
    backgroundColor: colors.success,
  },
  dotActive: {
    backgroundColor: colors.primary,
    transform: [{ scale: 1.15 }],
  },
  line: {
    flex: 1,
    height: 2,
    backgroundColor: colors.line,
    marginHorizontal: 6,
  },
  lineOn: {
    backgroundColor: colors.success,
  },
  stepText: {
    marginTop: 6,
    fontSize: 11,
    color: colors.faint,
  },
  stepTextActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  bar: {
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.line,
    marginTop: 16,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: colors.primary,
  },
  desc: {
    marginTop: 14,
    fontSize: 13,
    color: colors.muted,
  },
  button: {
    marginTop: 14,
    paddingVertical: 12,
    borderRadius: radius.button,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  buttonDisabled: {
    backgroundColor: colors.line,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
