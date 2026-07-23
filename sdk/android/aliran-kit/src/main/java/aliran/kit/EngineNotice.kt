// EngineNotice — the ready-made "this device can't run the P2P engine" screen for
// the !AliranBackend.isSupported() branch (Android 5-9 in a single APK). The Kotlin
// twin of the RN SDK's <EngineNotice>: brandable copy/colors, and an optional
// D-pad-focusable action button that is the HOST's seam for offering its own
// alternative method — this SDK ships the notice and the switch, never the delivery.
package aliran.kit

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

class EngineNotice(
    context: Context,
    title: String? = null,
    message: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
    backgroundColor: Int = Color.parseColor("#0B1220"),
    textColor: Int = Color.parseColor("#E5EEF7"),
    dimTextColor: Int = Color.parseColor("#93A4BF"),
    accentColor: Int = Color.parseColor("#0EA5E9"),
    onAccentColor: Int = Color.WHITE
) : FrameLayout(context) {

    init {
        setBackgroundColor(backgroundColor)
        val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt() }

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(32f), 0, dp(32f), 0)
        }

        if (title != null) {
            column.addView(TextView(context).apply {
                text = title
                setTextColor(textColor)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                gravity = Gravity.CENTER
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(10f) })
        }

        column.addView(TextView(context).apply {
            text = message ?: "This device can't run the P2P engine — Android 10 or newer is required."
            setTextColor(dimTextColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
        })

        if (onAction != null) {
            column.addView(TextView(context).apply {
                text = actionLabel ?: "Use another method"
                setTextColor(onAccentColor)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                setTypeface(typeface, android.graphics.Typeface.BOLD)
                gravity = Gravity.CENTER
                setPadding(dp(28f), dp(12f), dp(28f), dp(12f))
                background = GradientDrawable().apply {
                    setColor(accentColor)
                    cornerRadius = dp(6f).toFloat()
                }
                isFocusable = true
                isClickable = true
                // Visible focus feedback for D-pad/TV without theme plumbing.
                setOnFocusChangeListener { v, focused ->
                    v.scaleX = if (focused) 1.06f else 1f
                    v.scaleY = if (focused) 1.06f else 1f
                    v.alpha = if (focused) 0.92f else 1f
                }
                setOnClickListener { onAction() }
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(28f) })
        }

        addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }
}
